import { useEffect, useMemo, useState } from "react";
import { ClipboardPen, Save, Tag, UserRound } from "lucide-react";
import { saveEpisodeAnnotation, suggestTrajectoryCode } from "../lib/backend";
import type { EpisodeAnnotation, TaskDefinition, UserIdentity } from "../types";

interface AnnotationPanelProps {
  sourcePath: string;
  tasks: TaskDefinition[];
  annotation: EpisodeAnnotation | null;
  currentUser: UserIdentity;
  busy: boolean;
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
  onSaved,
  onError,
  onNotice,
}: AnnotationPanelProps) {
  const firstTask = tasks[0] ?? null;
  const [taskId, setTaskId] = useState("");
  const [trajectoryCode, setTrajectoryCode] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
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
      .then((code) => { if (active) setTrajectoryCode(code); })
      .catch((reason) => { if (active) onError(toMessage(reason)); });
    return () => { active = false; };
  }, [annotation, firstTask, onError, sourcePath]);

  const dirty = useMemo(() => {
    if (!annotation) return Boolean(taskId && trajectoryCode && description.trim());
    return taskId !== annotation.taskId
      || trajectoryCode !== annotation.trajectoryCode
      || description.trim() !== annotation.taskDescription;
  }, [annotation, description, taskId, trajectoryCode]);

  async function changeTask(nextTaskId: string) {
    const task = tasks.find((item) => item.id === nextTaskId);
    if (!task) return;
    setTaskId(task.id);
    setDescription(task.defaultDescription);
    if (annotation?.taskId === task.id) {
      setTrajectoryCode(annotation.trajectoryCode);
      return;
    }
    setTrajectoryCode("");
    try {
      setTrajectoryCode(await suggestTrajectoryCode(task.id));
    } catch (reason) {
      onError(toMessage(reason));
    }
  }

  async function save() {
    if (!taskId || !trajectoryCode || !description.trim()) return;
    setSaving(true);
    onError("");
    try {
      const saved = await saveEpisodeAnnotation({
        sourcePath,
        trajectoryCode,
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
          <label>
            <span><Tag size={14} />轨迹编码</span>
            <input type="text" value={trajectoryCode} readOnly aria-label="轨迹编码" />
          </label>
          <label>
            <span><ClipboardPen size={14} />任务</span>
            <select value={taskId} onChange={(event) => void changeTask(event.target.value)} disabled={!tasks.length || saving}>
              {tasks.map((task) => <option value={task.id} key={task.id}>{task.id}</option>)}
            </select>
            {tasks.find((task) => task.id === taskId)?.label ? (
              <small>{tasks.find((task) => task.id === taskId)?.label}</small>
            ) : null}
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
      <div className="annotation-actions">
        {annotation && annotation.processedBy.username !== currentUser.username ? (
          <span>保存后处理人将更新为 {currentUser.displayName}</span>
        ) : <span />}
        <button
          className="button button-primary"
          type="button"
          onClick={() => void save()}
          disabled={busy || saving || !dirty || !trajectoryCode || !description.trim()}
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
