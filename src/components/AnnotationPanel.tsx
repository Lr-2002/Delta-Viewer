import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPen, Plus, Save, Tag, UserRound, X } from "lucide-react";
import {
  createTaskDefinition,
  saveEpisodeAnnotation,
  suggestTrajectoryCode,
} from "../lib/backend";
import type { EpisodeAnnotation, TaskDefinition, UserIdentity } from "../types";

interface AnnotationPanelProps {
  sourcePath: string;
  tasks: TaskDefinition[];
  annotation: EpisodeAnnotation | null;
  currentUser: UserIdentity;
  busy: boolean;
  onTaskCreated: (task: TaskDefinition) => void;
  onSaved: (annotation: EpisodeAnnotation) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function AnnotationPanel({
  sourcePath,
  tasks,
  annotation,
  currentUser,
  busy,
  onTaskCreated,
  onSaved,
  onError,
  onNotice,
}: AnnotationPanelProps) {
  const firstTask = tasks[0] ?? null;
  const [taskId, setTaskId] = useState("");
  const [trajectoryCode, setTrajectoryCode] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [taskCreatorOpen, setTaskCreatorOpen] = useState(false);
  const [newTaskLabel, setNewTaskLabel] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  const previewRequest = useRef(0);

  useEffect(() => {
    let active = true;
    const requestId = ++previewRequest.current;
    if (annotation) {
      setTaskId(annotation.taskId);
      setTrajectoryCode(annotation.trajectoryCode);
      setDescription(annotation.taskDescription);
      return () => { active = false; };
    }
    if (!firstTask) {
      setTaskId("");
      setTrajectoryCode("");
      setDescription("");
      return () => { active = false; };
    }
    setTaskId(firstTask.id);
    setDescription(firstTask.defaultDescription);
    setTrajectoryCode("");
    void suggestTrajectoryCode(firstTask.id)
      .then((code) => { if (active && previewRequest.current === requestId) setTrajectoryCode(code); })
      .catch((reason) => { if (active && previewRequest.current === requestId) onError(toMessage(reason)); });
    return () => { active = false; };
  }, [annotation, firstTask, onError, sourcePath]);

  const dirty = useMemo(() => {
    if (!annotation) return Boolean(taskId && description.trim());
    return taskId !== annotation.taskId
      || description.trim() !== annotation.taskDescription;
  }, [annotation, description, taskId]);

  async function changeTask(nextTaskId: string) {
    const task = tasks.find((item) => item.id === nextTaskId);
    if (!task) return;
    setTaskId(task.id);
    setDescription(task.defaultDescription);
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

  async function save() {
    if (!taskId || !description.trim()) return;
    setSaving(true);
    onError("");
    try {
      const saved = await saveEpisodeAnnotation({
        sourcePath,
        taskId,
        taskDescription: description,
      });
      onSaved(saved);
      onNotice(`标注已保存：${saved.trajectoryCode} · ${saved.processedBy.displayName}`);
    } catch (reason) {
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
      setDescription(task.defaultDescription);
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

  const lastProcessor = annotation?.processedBy ?? currentUser;
  return (
    <section className="annotation-section" aria-labelledby="annotation-title">
      <header className="annotation-heading">
        <div>
          <span className="section-kicker">DATA ANNOTATION</span>
          <h2 id="annotation-title">数据标注</h2>
        </div>
        <span className={`annotation-state${annotation && !dirty ? " saved" : ""}`}>
          {annotation && !dirty ? `已保存 · r${annotation.revision}` : "待保存"}
        </span>
      </header>
      <div className="annotation-layout">
        <div className="annotation-fields">
          <div className="annotation-task-field">
            <span className="annotation-field-label"><ClipboardPen size={14} />任务</span>
            <div className="annotation-task-control">
              <select value={taskId} onChange={(event) => void changeTask(event.target.value)} disabled={!tasks.length || saving || creatingTask} aria-label="任务">
                {tasks.map((task) => <option value={task.id} key={task.id}>{task.label}</option>)}
              </select>
              <button
                className="icon-button annotation-task-add"
                type="button"
                onClick={() => setTaskCreatorOpen((value) => !value)}
                disabled={busy || saving || creatingTask}
                title="创建任务"
                aria-label="创建任务"
                aria-expanded={taskCreatorOpen}
              >
                {taskCreatorOpen ? <X size={15} /> : <Plus size={15} />}
              </button>
            </div>
            {tasks.find((task) => task.id === taskId)?.codePrefix ? (
              <small>{tasks.find((task) => task.id === taskId)?.codePrefix}-NNN</small>
            ) : null}
          </div>
          <label>
            <span><Tag size={14} />轨迹编码</span>
            <input type="text" value={trajectoryCode} placeholder="保存时自动分配" readOnly aria-label="轨迹编码" />
          </label>
          <div className="annotation-processor">
            <UserRound size={15} />
            <span>
              <small>{annotation ? "最近处理" : "本次处理"}</small>
              <strong>{lastProcessor.displayName}</strong>
              <code>@{lastProcessor.username}</code>
            </span>
          </div>
        </div>
        <label className="annotation-description">
          <span>任务描述</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
            rows={5}
            required
          />
          <small>{description.length}/500 · 可编辑</small>
        </label>
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
      <div className="annotation-actions">
        {annotation && annotation.processedBy.username !== currentUser.username ? (
          <span>保存后处理人将更新为 {currentUser.displayName}</span>
        ) : <span />}
        <button
          className="button button-primary"
          type="button"
          onClick={() => void save()}
          disabled={busy || saving || creatingTask || !dirty || !taskId || !description.trim()}
        >
          <Save size={16} />
          {saving ? "保存中" : "保存标注"}
        </button>
      </div>
    </section>
  );
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
