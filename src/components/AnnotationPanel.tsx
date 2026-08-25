import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPen, FileUp, Plus, Save, Tag, Trash2, UserRound, X } from "lucide-react";
import {
  confirmAction,
  createTaskDefinition,
  deleteTaskDefinition,
  importTaskTemplateConfig,
  isTauriRuntime,
  saveEpisodeAnnotation,
  suggestTrajectoryCode,
} from "../lib/backend";
import { descriptionMetadataPath } from "../lib/format";
import type { AnnotationAuditAction, EpisodeAnnotation, TaskDefinition, UserIdentity } from "../types";

interface AnnotationPanelProps {
  sourcePath: string;
  tasks: TaskDefinition[];
  annotation: EpisodeAnnotation | null;
  currentUser: UserIdentity | null;
  offlineMode: boolean;
  busy: boolean;
  onTaskCreated: (task: TaskDefinition) => void;
  onTaskDeleted: (taskId: string) => void;
  onTaskSelected: (taskId: string | null) => void;
  onTasksImported: (tasks: TaskDefinition[]) => void;
  onSaved: (annotation: EpisodeAnnotation) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onActivity: (action: AnnotationAuditAction, taskId: string, trajectoryCode: string) => void;
}

const CUSTOM_DESCRIPTION_VALUE = "__custom_description__";

export function AnnotationPanel({
  sourcePath,
  tasks,
  annotation,
  currentUser,
  offlineMode,
  busy,
  onTaskCreated,
  onTaskDeleted,
  onTaskSelected,
  onTasksImported,
  onSaved,
  onError,
  onNotice,
  onActivity,
}: AnnotationPanelProps) {
  const firstTask = tasks[0] ?? null;
  const [taskId, setTaskId] = useState("");
  const [trajectoryCode, setTrajectoryCode] = useState("");
  const [description, setDescription] = useState("");
  const [customDescriptionOpen, setCustomDescriptionOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [taskCreatorOpen, setTaskCreatorOpen] = useState(false);
  const [newTaskLabel, setNewTaskLabel] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  const [importingTemplates, setImportingTemplates] = useState(false);
  const [editStartedAtMs, setEditStartedAtMs] = useState(() => Date.now());
  const [draftRestored, setDraftRestored] = useState(false);
  const previewRequest = useRef(0);
  const previousSourcePath = useRef<string | null>(null);
  const taskIds = tasks.map((task) => task.id).join("\u0000");
  const draftKey = `dohc-viewer.annotation-draft.v1:${currentUser?.username ?? "offline"}:${sourcePath}`;

  useEffect(() => {
    let active = true;
    const sourceChanged = previousSourcePath.current !== sourcePath;
    previousSourcePath.current = sourcePath;
    if (annotation) {
      ++previewRequest.current;
      setTaskId(annotation.taskId);
      onTaskSelected(annotation.taskId);
      setTrajectoryCode(annotation.trajectoryCode);
      setDescription(annotation.taskDescription);
      const annotationTask = tasks.find((task) => task.id === annotation.taskId);
      setCustomDescriptionOpen(Boolean(annotationTask && !predefinedDescriptions(annotationTask).includes(annotation.taskDescription)));
      setEditStartedAtMs(Date.now());
      setDraftRestored(false);
      return () => { active = false; };
    }
    if (sourceChanged) {
      try {
        const draft = JSON.parse(localStorage.getItem(draftKey) ?? "null") as { taskId?: string; description?: string; editStartedAtMs?: number } | null;
        const draftTask = draft?.taskId ? tasks.find((task) => task.id === draft.taskId) : null;
        if (draftTask && typeof draft?.description === "string") {
          const requestId = ++previewRequest.current;
          setTaskId(draftTask.id);
          onTaskSelected(draftTask.id);
          setDescription(draft.description);
          setCustomDescriptionOpen(!predefinedDescriptions(draftTask).includes(draft.description));
          setTrajectoryCode("");
          setEditStartedAtMs(Number.isSafeInteger(draft.editStartedAtMs) ? draft.editStartedAtMs! : Date.now());
          setDraftRestored(true);
          void suggestTrajectoryCode(draftTask.id)
            .then((code) => { if (active && previewRequest.current === requestId) setTrajectoryCode(code); })
            .catch((reason) => { if (active && previewRequest.current === requestId) onError(toMessage(reason)); });
          return () => { active = false; };
        }
      } catch { localStorage.removeItem(draftKey); }
    }
    if (!firstTask) {
      ++previewRequest.current;
      setTaskId("");
      onTaskSelected(null);
      setTrajectoryCode("");
      setDescription("");
      setCustomDescriptionOpen(false);
      return () => { active = false; };
    }
    // A newly created task reaches this component before its parent task list
    // updates. Only reset selection on a source switch or a confirmed list update.
    if (!sourceChanged && taskId && tasks.some((task) => task.id === taskId)) {
      return () => { active = false; };
    }
    const requestId = ++previewRequest.current;
    setTaskId(firstTask.id);
    onTaskSelected(firstTask.id);
    setDescription(firstTask.defaultDescription);
    setCustomDescriptionOpen(false);
    setTrajectoryCode("");
    setEditStartedAtMs(Date.now());
    setDraftRestored(false);
    void suggestTrajectoryCode(firstTask.id)
      .then((code) => { if (active && previewRequest.current === requestId) setTrajectoryCode(code); })
      .catch((reason) => { if (active && previewRequest.current === requestId) onError(toMessage(reason)); });
    return () => { active = false; };
  }, [
    annotation,
    firstTask?.defaultDescription,
    firstTask?.id,
    onError,
    onTaskSelected,
    sourcePath,
    taskIds,
    draftKey,
  ]);

  useEffect(() => {
    if (annotation || !taskId) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ taskId, description, editStartedAtMs }));
    } catch { /* The visible unsaved state remains authoritative. */ }
  }, [annotation, description, draftKey, editStartedAtMs, taskId]);

  const activeTask = tasks.find((task) => task.id === taskId) ?? null;
  const descriptionOptions = activeTask ? predefinedDescriptions(activeTask) : [];

  const dirty = useMemo(() => {
    if (!annotation) return Boolean(taskId && description.trim());
    return taskId !== annotation.taskId
      || description.trim() !== annotation.taskDescription;
  }, [annotation, description, taskId]);

  async function changeTask(nextTaskId: string) {
    const task = tasks.find((item) => item.id === nextTaskId);
    if (!task) return;
    setTaskId(task.id);
    onTaskSelected(task.id);
    setDescription(task.defaultDescription);
    setCustomDescriptionOpen(false);
    onActivity("task_changed", task.id, trajectoryCode);
    const requestId = ++previewRequest.current;
    if (annotation?.taskId === task.id) {
      setTrajectoryCode(annotation.trajectoryCode);
      return;
    }
    setTrajectoryCode("");
    try {
      const code = await suggestTrajectoryCode(task.id);
      if (previewRequest.current === requestId) setTrajectoryCode(code);
    } catch (reason) {
      if (previewRequest.current === requestId) onError(toMessage(reason));
    }
  }

  async function save(descriptionOverride?: string) {
    const nextDescription = (descriptionOverride ?? description).trim();
    if (!taskId || !nextDescription) return;
    const segmentCount = annotation?.segments.length ?? 0;
    const coveredFrames = annotation?.segments.reduce((sum, segment) => sum + segment.endFrame - segment.startFrame + 1, 0) ?? 0;
    if (!await confirmAction(`当前任务：${activeTask?.label ?? taskId}\n片段数：${segmentCount}\n覆盖帧数：${coveredFrames}\n\n确认保存当前标注？`, "确认保存标注")) return;
    setSaving(true);
    onError("");
    try {
      const saved = await saveEpisodeAnnotation({
        sourcePath,
        taskId,
        taskDescription: nextDescription,
        editStartedAtMs,
        clipStartFrame: annotation?.clipStartFrame ?? null,
        clipEndFrame: annotation?.clipEndFrame ?? null,
        segments: annotation?.segments ?? [],
      });
      setEditStartedAtMs(Date.now());
      localStorage.removeItem(draftKey);
      setDraftRestored(false);
      onSaved(saved);
      onActivity("annotation_saved", saved.taskId, saved.trajectoryCode);
      const persistenceNotice = isTauriRuntime()
        ? `标注已保存到 ${descriptionMetadataPath(saved.episodeRoot)}`
        : "浏览器演示已保存";
      onNotice(offlineMode
        ? `${saved.trajectoryCode} · ${persistenceNotice}`
        : `${saved.trajectoryCode} · ${saved.processedBy.displayName} · ${persistenceNotice}`);
    } catch (reason) {
      onActivity("annotation_save_failed", taskId, trajectoryCode);
      onError(toMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function createTask() {
    if (!newTaskLabel.trim()) return;
    setCreatingTask(true);
    onError("");
    try {
      const task = await createTaskDefinition({ label: newTaskLabel });
      onTaskCreated(task);
      setTaskId(task.id);
      onTaskSelected(task.id);
      setDescription(task.defaultDescription);
      setCustomDescriptionOpen(false);
      setTrajectoryCode("");
      const requestId = ++previewRequest.current;
      setNewTaskLabel("");
      setTaskCreatorOpen(false);
      onNotice(`任务已创建：${task.label}`);
      try {
        const code = await suggestTrajectoryCode(task.id);
        if (previewRequest.current === requestId) setTrajectoryCode(code);
      } catch (reason) {
        onError(`任务已创建，但暂时无法预览轨迹编码：${toMessage(reason)}`);
      }
    } catch (reason) {
      onError(toMessage(reason));
    } finally {
      setCreatingTask(false);
    }
  }

  async function importTemplates() {
    setImportingTemplates(true);
    onError("");
    try {
      const nextTasks = await importTaskTemplateConfig();
      const previousIds = new Set(tasks.map((task) => task.id));
      const imported = nextTasks.filter((task) => !previousIds.has(task.id));
      onTasksImported(nextTasks);
      const selected = imported[0] ?? null;
      if (selected) {
        setTaskId(selected.id);
        onTaskSelected(selected.id);
        setDescription(selected.defaultDescription);
        setCustomDescriptionOpen(false);
        setTrajectoryCode("");
        const requestId = ++previewRequest.current;
        try {
          const code = await suggestTrajectoryCode(selected.id);
          if (previewRequest.current === requestId) setTrajectoryCode(code);
        } catch (reason) {
          onError(`任务模板已导入，但暂时无法预览轨迹编码：${toMessage(reason)}`);
        }
      }
      onNotice(`已导入 ${imported.length} 个任务模板`);
    } catch (reason) {
      onError(toMessage(reason));
    } finally {
      setImportingTemplates(false);
    }
  }

  async function deleteTask() {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.id === "close_oven") return;
    if (!(await confirmAction(`确定删除任务“${task.label}”？`, "删除任务"))) return;
    setCreatingTask(true);
    onError("");
    try {
      await deleteTaskDefinition(task.id);
      onTaskDeleted(task.id);
      onNotice(`任务已删除：${task.label}`);
    } catch (reason) {
      onError(toMessage(reason));
    } finally {
      setCreatingTask(false);
    }
  }

  const lastProcessor = annotation?.processedBy ?? currentUser;
  return (
    <section className="annotation-section" aria-labelledby="annotation-title">
      <header className="annotation-heading">
        <div>
          <span className="section-kicker">DATA ANNOTATION</span>
          <h2 id="annotation-title">数据标注</h2>
        </div>
        <div className="annotation-heading-actions">
          {!offlineMode && lastProcessor ? (
            <div className="annotation-processor">
              <UserRound size={15} />
              <span>
                <small>{annotation ? "最近处理" : "本次处理"}</small>
                <strong>{lastProcessor.displayName}</strong>
                <code>@{lastProcessor.username}</code>
              </span>
            </div>
          ) : null}
          <span className={`annotation-state${annotation && !dirty ? " saved" : ""}`}>
            {annotation && !dirty ? `已保存 · r${annotation.revision}` : draftRestored ? "已恢复本机草稿" : "草稿已自动保存"}
          </span>
          <button
            className="button button-primary"
            type="button"
            onClick={() => void save()}
            disabled={busy || saving || creatingTask || importingTemplates || !dirty || !taskId || !description.trim()}
          >
            <Save size={16} />
            {saving ? "保存中" : "保存标注"}
          </button>
        </div>
      </header>
      <div className="annotation-layout">
        <div className="annotation-fields">
          <div className="annotation-task-field">
            <span className="annotation-field-label"><ClipboardPen size={14} />任务</span>
            <div className="annotation-task-control">
              <select value={taskId} onChange={(event) => void changeTask(event.target.value)} disabled={!tasks.length || saving || creatingTask || importingTemplates} aria-label="任务">
                {tasks.map((task) => <option value={task.id} key={task.id}>{task.label}</option>)}
              </select>
              <button
                className="icon-button annotation-task-add"
                type="button"
                onClick={() => setTaskCreatorOpen((value) => !value)}
                disabled={busy || saving || creatingTask || importingTemplates}
                title="创建任务"
                aria-label="创建任务"
                aria-expanded={taskCreatorOpen}
              >
                {taskCreatorOpen ? <X size={15} /> : <Plus size={15} />}
              </button>
              <button
                className="icon-button annotation-task-import"
                type="button"
                onClick={() => void importTemplates()}
                disabled={busy || saving || creatingTask || importingTemplates}
                title="导入任务模板配置"
                aria-label="导入模板配置"
              >
                <FileUp size={15} />
              </button>
              <button
                className="icon-button annotation-task-delete"
                type="button"
                onClick={() => void deleteTask()}
                disabled={busy || saving || creatingTask || importingTemplates || !taskId || taskId === "close_oven"}
                title="删除当前自定义任务"
                aria-label="删除当前自定义任务"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
          <label>
            <span><Tag size={14} />轨迹编码</span>
            <input type="text" value={trajectoryCode} placeholder="保存时自动分配" readOnly aria-label="轨迹编码" />
          </label>
          <label className={`annotation-description${customDescriptionOpen ? " custom" : ""}`}>
            <span>任务描述</span>
            <select
              value={customDescriptionOpen ? CUSTOM_DESCRIPTION_VALUE : description}
              onChange={(event) => {
                if (event.target.value === CUSTOM_DESCRIPTION_VALUE) {
                  setDescription("");
                  setCustomDescriptionOpen(true);
                  return;
                }
                setCustomDescriptionOpen(false);
                setDescription(event.target.value);
                onActivity("description_changed", taskId, trajectoryCode);
              }}
              disabled={!activeTask || saving || creatingTask || importingTemplates}
              aria-label="任务描述"
            >
              {descriptionOptions.map((option) => (
                <option value={option} key={option}>{option}</option>
              ))}
              <option value={CUSTOM_DESCRIPTION_VALUE}>自定义描述</option>
            </select>
            {customDescriptionOpen ? (
              <input
                className="annotation-custom-description"
                type="text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                onBlur={(event) => {
                  const value = event.currentTarget.value.trim();
                  onActivity("description_changed", taskId, trajectoryCode);
                  if (value) setDescription(value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                placeholder="输入自定义任务描述"
                maxLength={500}
                disabled={saving || creatingTask || importingTemplates}
                autoFocus
                required
              />
            ) : null}
          </label>
        </div>
      </div>
      {taskCreatorOpen ? (
        <form className="task-create-form" onSubmit={(event) => { event.preventDefault(); void createTask(); }}>
          <label>
            <span>新任务名称</span>
            <input
              type="text"
              value={newTaskLabel}
              onChange={(event) => setNewTaskLabel(event.target.value)}
              maxLength={64}
              autoFocus
              required
            />
          </label>
          <button className="button button-primary" type="submit" disabled={busy || creatingTask || !newTaskLabel.trim()}>
            <Plus size={15} />
            {creatingTask ? "创建中" : "创建任务"}
          </button>
        </form>
      ) : null}
      {!offlineMode && annotation && currentUser && annotation.processedBy.username !== currentUser.username ? (
        <p className="annotation-processor-notice">保存后处理人将更新为 {currentUser.displayName}</p>
      ) : null}
    </section>
  );
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function predefinedDescriptions(task: TaskDefinition): string[] {
  return Array.from(new Set([
    ...task.descriptionOptions,
    task.defaultDescription,
  ].map((value) => value.trim()).filter(Boolean)));
}
