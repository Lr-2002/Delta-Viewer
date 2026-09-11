export const reviewActionLabels = {
  loaded: "载入数据",
  closed: "离开数据",
  heartbeat: "在线心跳",
  focus: "返回窗口",
  blur: "离开窗口",
  seek: "定位视频",
  drag: "拖动时间轴",
  play: "播放",
  pause: "暂停",
  control: "操作控件",
  shortcut: "快捷操作",
  scroll: "滚动列表",
  view: "切换视图",
  source: "切换机标",
  segment_edit: "修改片段",
  segment_select: "选择片段",
  label_add: "新增标签",
  label_delete: "删除标签",
  label_apply: "使用标签",
  saved: "保存修改",
  approved: "审核通过",
  rejected: "审核不通过",
  save_failed: "保存失败",
} as const;
export type ReviewAction = keyof typeof reviewActionLabels;
export type ReviewDetails = Partial<
  Record<
    | "target"
    | "value"
    | "before"
    | "after"
    | "frameFrom"
    | "frameTo"
    | "mediaTimeMs"
    | "durationMs"
    | "segmentIndex"
    | "startFrame"
    | "endFrame"
    | "revision"
    | "reason"
    | "labelId"
    | "sourceName",
    string | number
  >
>;
export interface ReviewAuditEvent {
  eventId: string;
  sessionId: string;
  episodeKey: string;
  episodeName: string;
  action: ReviewAction;
  occurredAtMs: number;
  elapsedMs: number;
  details: ReviewDetails;
}
export interface ReviewEvent extends ReviewAuditEvent {
  id: number;
  username: string;
  displayName: string;
  receivedAtMs: number;
}
export interface ReviewUserSummary {
  username: string;
  displayName: string;
  accountStatus: string;
  online: boolean;
  operations: number;
  approved: number;
  rejected: number;
  seeks: number;
  labelsAdded: number;
  labelsDeleted: number;
  averageMs: number | null;
  lastActivityAtMs: number | null;
}
export interface ReviewSessionSummary {
  username: string;
  sessionId: string;
  episodeKey: string;
  episodeName: string;
  loadedAtMs: number;
  lastActivityAtMs: number;
  operations: number;
  durationMs: number | null;
  status: "pending" | "approved" | "rejected";
}
export interface ReviewDashboardData {
  events: ReviewEvent[];
  users: ReviewUserSummary[];
  sessions: ReviewSessionSummary[];
  nextBefore: number | null;
  nextSessionBefore: number | null;
  total: number;
  generatedAtMs: number;
}
