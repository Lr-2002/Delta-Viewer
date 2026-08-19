import { CalendarDays, CheckCircle2, FolderOpen, RefreshCw, X } from "lucide-react";
import type { AssignedTask, AssignedTaskActivity } from "../types";

interface PersonalTaskPanelProps {
  sourceRoot: string | null;
  tasks: AssignedTask[];
  activity: AssignedTaskActivity | null;
  date: string;
  loading: boolean;
  onDateChange: (date: string) => void;
  onRefresh: () => void;
  onChooseSource: () => void;
  onClose: () => void;
}

const actionLabels: Record<string, string> = {
  annotation_started: "开始标注",
  task_changed: "切换任务",
  description_changed: "修改描述",
  clip_changed: "调整片段",
  segment_split: "拆分分段",
  segment_template_selected: "选择分段模板",
  segment_note_changed: "修改分段备注",
  segment_deleted: "删除分段",
  annotation_saved: "保存标注",
  export_started: "开始导出",
  export_finished: "完成导出",
  annotation_ended: "结束标注",
};

export function PersonalTaskPanel({ sourceRoot, tasks, activity, date, loading, onDateChange, onRefresh, onChooseSource, onClose }: PersonalTaskPanelProps) {
  const events = activity?.events ?? [];
  const saved = new Set(events.filter((event) => event.action === "annotation_saved").map((event) => event.trajectoryCode || event.eventId));
  return (
    <section className="personal-task-panel" onClick={(event) => event.stopPropagation()}>
      <div className="personal-task-heading">
        <div><span className="section-kicker">MY TASKS</span><h2>个人任务详情</h2><small>登录后可查看分配任务，并在本机配置任务文件夹</small></div>
        <div className="personal-task-actions">
          <label className="personal-date-picker"><CalendarDays size={14} /><input type="date" value={date} onChange={(event) => onDateChange(event.target.value)} /></label>
          <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} title="刷新当天标注记录" aria-label="刷新当天标注记录"><RefreshCw className={loading ? "spin" : ""} size={15} /></button>
          <button className="icon-button" type="button" onClick={onClose} title="关闭个人任务详情" aria-label="关闭个人任务详情"><X size={15} /></button>
        </div>
      </div>
      <div className="personal-source-row">
        <FolderOpen size={15} />
        <span className={sourceRoot ? "" : "muted"} title={sourceRoot ?? undefined}>{sourceRoot ?? "尚未配置任务文件夹"}</span>
        <button className="button button-secondary" type="button" onClick={onChooseSource}><FolderOpen size={14} />{sourceRoot ? "更换并加载" : "选择并加载任务文件夹"}</button>
      </div>
      <div className="personal-task-grid">
        <div>
          <div className="personal-subheading"><strong>{date === localDateInput() ? "今日任务" : `${date} 的分配任务`}</strong><span>{tasks.length} 类 · {tasks.reduce((sum, task) => sum + task.quantity, 0)} 个</span></div>
          {tasks.length ? <div className="personal-assignment-list">{tasks.map((task) => <div className="personal-assignment-row" key={`${task.task}-${task.startIndex}`}><strong>{task.task}</strong><span>{task.detail}</span><b>{task.quantity} 个</b><small>起始序号 {task.startIndex}</small></div>)}</div> : <div className="personal-empty">当前没有监管分配任务。</div>}
        </div>
        <div>
          <div className="personal-subheading"><strong>标注详情</strong><span><CheckCircle2 size={13} />已保存 {saved.size} 条 · 共 {events.length} 条操作</span></div>
          {events.length ? <div className="personal-activity-list">{events.map((event) => <div className="personal-activity-row" key={event.eventId}><span>{new Date(event.occurredAtMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span><strong>{actionLabels[event.action] ?? event.action}</strong><span>{event.taskId || "未选择任务"}</span><small>{event.trajectoryCode || "—"}</small></div>)}</div> : <div className="personal-empty">这一天还没有标注操作记录。</div>}
        </div>
      </div>
    </section>
  );
}

function localDateInput(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
