export type TaskName = "scan" | "import" | "validate" | "export" | "update";

export interface UserIdentity {
  username: string;
  displayName: string;
  role?: "admin" | "operator";
}

export interface SupervisionUserSummary {
  username: string;
  displayName: string;
  role: "admin" | "operator";
  assignedTasks: number;
  assignedTaskNames: string[];
  assignedTaskQuantities: Record<string, number>;
  assignmentPlans: AssignmentPlan[];
  completedToday: number;
  totalCompleted: number;
  remainingTasks: number;
  averageCompletionMs: number | null;
  completionRatePerHour: number;
  estimatedCompletionAtMs: number | null;
  firstActivityAtMs: number | null;
  lastActivityAtMs: number | null;
  lastLoginAtMs: number | null;
  operationCount: number;
  possibleStagnation: boolean;
  accountStatus: "active" | "paused";
}

export interface SupervisionEvent {
  eventId: string;
  username: string;
  displayName: string;
  taskId: string;
  trajectoryCode: string;
  action: AnnotationAuditAction;
  occurredAtMs: number;
  receivedAtMs: number;
}

export interface SupervisionAccount {
  username: string;
  displayName: string;
  role: "admin" | "operator";
  assignedTasks: number;
  assignedTaskNames: string[];
  assignedTaskQuantities: Record<string, number>;
  assignmentPlans: AssignmentPlan[];
  assignmentUpdatedAtMs: number;
  lastLoginAtMs: number | null;
  createdAtMs: number;
  accountStatus: "active" | "paused";
}

export interface BatchAccountInput {
  username: string;
  displayName: string;
  password: string;
}

export interface SupervisionDashboardData {
  users: SupervisionUserSummary[];
  events: SupervisionEvent[];
  accounts: SupervisionAccount[];
  taskDetails: SupervisionTaskDetail[];
  overview: OperationsOverview;
  taskSummaries: OperationsTaskSummary[];
  hourlyTrend: HourlyCompletion[];
  dailyTrend: DailyCompletion[];
  alerts: OperationsAlert[];
  qualityReviews: QualityReview[];
  generatedAtMs: number;
}

export type AssignmentPriority = "normal" | "urgent" | "rework";
export type AssignmentStatus = "active" | "paused";

export interface AssignmentPlan {
  task: string;
  quantity: number;
  startIndex: number;
  priority: AssignmentPriority;
  deadlineAtMs: number | null;
  status: AssignmentStatus;
  order: number;
  completed?: number;
  remaining?: number;
  estimatedCompletionAtMs?: number | null;
}

export interface AssignmentTransferResult {
  source: SupervisionAccount;
  target: SupervisionAccount;
}

export interface OperationsOverview {
  completedToday: number;
  totalCompleted: number;
  assigned: number;
  remaining: number;
  activeOperators: number;
  possibleStagnation: number;
  averageCompletionMs: number | null;
}

export interface OperationsTaskSummary {
  task: string;
  assigned: number;
  completedToday: number;
  totalCompleted: number;
  remaining: number;
  operatorCount: number;
  averageCompletionMs: number | null;
}

export interface HourlyCompletion {
  hour: number;
  completed: number;
}

export interface DailyCompletion {
  date: string;
  completed: number;
}

export type OperationsAlertStatus = "open" | "acknowledged" | "closed";

export interface OperationsAlert {
  alertId: string;
  type: "possible_stagnation" | "duplicate_assignment" | string;
  severity: "medium" | "high";
  status: OperationsAlertStatus;
  username: string;
  taskId: string;
  message: string;
  detectedAtMs: number;
  updatedAtMs: number;
  note: string;
  updatedBy: string | null;
}

export interface QualityReview {
  reviewId: string;
  taskId: string;
  trajectoryCode: string;
  outcome: "passed" | "rework";
  errorType: string;
  note: string;
  reviewer: string;
  reviewedAtMs: number;
  annotatorUsername: string;
  annotationRevision: number | null;
  segmentIndex: number | null;
  startFrame: number | null;
  endFrame: number | null;
  parentReviewId: string | null;
  reworkAssignmentCreated: boolean;
}

export interface QualityReviewRequest {
  taskId: string;
  trajectoryCode: string;
  outcome: "passed" | "rework";
  errorType: string;
  note: string;
  annotatorUsername: string;
  annotationRevision: number | null;
  segmentIndex: number | null;
  startFrame: number | null;
  endFrame: number | null;
  parentReviewId: string | null;
}

export interface SupervisionTaskDetail {
  task: string;
  detail: string;
  source: "imported" | "admin";
  updatedAtMs: number;
  updatedBy: string;
}

export interface SupervisionTaskImportResult {
  taskDetails: SupervisionTaskDetail[];
  importedTaskNames: string[];
}

export interface AssignedTask {
  task: string;
  detail: string;
  quantity: number;
  startIndex: number;
  priority: AssignmentPriority;
  deadlineAtMs: number | null;
  status: AssignmentStatus;
  order: number;
  completed: number;
  remaining: number;
  estimatedCompletionAtMs: number | null;
}

export interface AssignedTaskActivity {
  date: string;
  events: SupervisionEvent[];
}

export interface SupervisionTaskSummary {
  task: string;
  completed: number;
  total: number;
  completedFrames: number;
  totalFrames: number;
}

export interface SupervisionTaskCatalog {
  sourcePath: string;
  tasks: SupervisionTaskSummary[];
}

export interface SupervisionAnnotationCatalog {
  sourceName: string;
  users: SupervisionAnnotationUserSummary[];
}

export interface SupervisionAnnotationUserSummary {
  username: string;
  displayName: string;
  trajectoryCount: number;
  segmentCount: number;
  annotatedFrameCount: number;
  tasks: SupervisionAnnotationTaskSummary[];
  entries: SupervisionAnnotationEntry[];
}

export interface SupervisionAnnotationTaskSummary {
  taskId: string;
  trajectoryCount: number;
  segmentCount: number;
  annotatedFrameCount: number;
}

export interface SupervisionAnnotationEntry {
  taskId: string;
  trajectoryCode: string;
  revision: number;
  segmentCount: number;
  annotatedFrameCount: number;
  updatedAtMs: number;
}

export type WorkspaceMode = "managed" | "offline";

export interface AuthStatus {
  workspaceMode: WorkspaceMode | null;
  userCenter: UserCenterStatus;
  currentUser: UserIdentity | null;
}

export interface UserCenterStatus {
  configured: boolean;
  endpoint: string | null;
  serviceId: string | null;
}

export interface TaskDefinition {
  id: string;
  label: string;
  codePrefix: string;
  defaultDescription: string;
  descriptionOptions: string[];
  defaultSegments: string[];
}

export interface CreateTaskRequest {
  label: string;
}

export interface EpisodeAnnotation {
  formatVersion: number;
  episodeId: string;
  episodeRoot: string;
  episodeFingerprint: string;
  trajectoryCode: string;
  taskId: string;
  taskDescription: string;
  processedBy: UserIdentity;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  editStartedAtMs: number;
  editDurationMs: number;
  clipStartFrame: number | null;
  clipEndFrame: number | null;
  segments: SegmentAnnotation[];
}

export interface SegmentAnnotation {
  startFrame: number;
  endFrame: number;
  title: string;
  note: string;
}

export interface AnnotatedEpisodeSummary {
  annotation: EpisodeAnnotation;
  sourceAvailable: boolean;
}

export interface SaveAnnotationRequest {
  sourcePath: string;
  taskId: string;
  taskDescription: string;
  editStartedAtMs: number;
  clipStartFrame: number | null;
  clipEndFrame: number | null;
  segments: SegmentAnnotation[];
}

export type AnnotationAuditAction =
  | "annotation_started" | "task_changed" | "description_changed" | "clip_changed"
  | "segment_split" | "segment_template_selected" | "segment_note_changed"
  | "segment_deleted" | "annotation_saved" | "export_started" | "export_finished"
  | "annotation_ended" | "episode_opened" | "source_unavailable"
  | "annotation_save_failed" | "validation_warning" | "validation_error"
  | "user_center_unavailable";

export interface AnnotationAuditRequest {
  eventId: string;
  taskId: string;
  trajectoryCode: string;
  action: AnnotationAuditAction;
  occurredAtMs: number;
}

export type SupervisionReportKind = "daily" | "weekly" | "task";
export type SupervisionReportFormat = "json" | "csv" | "html";

export interface SupervisionReportExportResult {
  outputPath: string;
  totalBytes: number;
  elapsedMs: number;
}

export interface StreamSummary {
  name: string;
  label: string;
  frameCount: number;
  firstFrame: number | null;
  lastFrame: number | null;
  missingFrames: number[];
  missingFrameCount: number;
  totalBytes: number;
  width: number | null;
  height: number | null;
  channels: number | null;
}

export interface VideoSource {
  fps: number;
  mediaFps: number;
  segmentSeconds: number;
  startFrame: number;
  paths: string[];
}

export interface EpisodeSummary {
  root: string;
  name: string;
  indexed: boolean;
  totalFiles: number;
  totalBytes: number;
  stateCount: number;
  startTimeNs: string | null;
  endTimeNs: string | null;
  streams: StreamSummary[];
}

export interface EpisodeValidationResult {
  report: ValidationReport;
  summary: EpisodeSummary;
}

export interface ScanResult {
  sourceRoot: string;
  episodes: EpisodeSummary[];
  totalFiles: number;
  totalBytes: number;
  volume: VolumeInfo;
}

export interface VolumeInfo {
  root: string;
  filesystem: string | null;
  driveType: "removable" | "fixed" | "remote" | "optical" | "ramdisk" | "unknown";
  totalBytes: number;
  availableBytes: number;
}

export interface PreflightIssue {
  code: string;
  message: string;
}

export interface PartialImport {
  path: string;
  name: string;
  sourceName: string;
  createdAtMs: number;
}

export interface ImportPreflight {
  canImport: boolean;
  sourceBytes: number;
  requiredBytes: number;
  largestFileBytes: number;
  volume: VolumeInfo;
  issues: PreflightIssue[];
  partials: PartialImport[];
}

export interface StateRecord {
  frameId: number;
  captureTimeNs: string;
  position: [number, number, number];
  velocity: [number, number, number];
  quaternion: [number, number, number, number];
  euler: [number, number, number];
  omega: [number, number, number];
  confidence: number;
}

export interface SkeletonFrame {
  frameId: number;
  joints: [number, number, number][];
}

export interface SkeletonSeries {
  sourceName: string;
  frameCount: number;
  jointCount: number;
  frames: SkeletonFrame[];
}

export interface EpisodeData {
  summary: EpisodeSummary;
  states: StateRecord[];
  skeleton: SkeletonSeries | null;
  skeletonError: string | null;
}

export type Severity = "warning" | "error";

export interface ValidationIssue {
  severity: Severity;
  code: string;
  scope: string;
  message: string;
  frameId: number | null;
}

export interface StreamValidation {
  name: string;
  checkedFrames: number;
  decodeFailures: number;
  status: "ok" | "warning" | "error";
}

export interface StateFrameRate {
  expectedFps: number;
  measuredFps: number | null;
  tolerancePercent: number;
  intervalCount: number;
  stabilityPercent: number | null;
  stable: boolean | null;
}

export interface ValidationReport {
  formatVersion: number;
  episodeRoot: string;
  parsedStateCount: number;
  imageValidationMode: "sampled" | "full";
  imageSamplePercentages: number[];
  stateFrameRate: StateFrameRate;
  autoReportPath: string | null;
  status: "ok" | "warning" | "error";
  checkedFiles: number;
  elapsedMs: number;
  issues: ValidationIssue[];
  streams: StreamValidation[];
}

export interface ReportExportResult {
  outputPath: string;
  totalBytes: number;
  elapsedMs: number;
}

export interface TaskProgress {
  operationId: number;
  task: TaskName;
  phase: string;
  current: number;
  total: number;
  bytesDone: number;
  totalBytes: number;
  currentPath: string;
  elapsedMs: number;
}

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  notes: string | null;
  publishedAt: string | null;
}

export interface ImportResult {
  destination: string;
  totalFiles: number;
  totalBytes: number;
  datasetBlake3: string;
  elapsedMs: number;
  validationReport: ValidationReport | null;
}

export interface OperationErrorRecord {
  formatVersion: number;
  id: string;
  occurredAtMs: number;
  operation: string;
  code: string;
  message: string;
  sourcePath: string | null;
  processedBy: UserIdentity;
}

export interface RecordOperationErrorRequest {
  operation: string;
  message: string;
  sourcePath: string | null;
}

export type ExportFormat = "mcap" | "hdf5" | "lerobot_v2";

export interface ExportRange {
  startFrame: number;
  endFrame: number;
}

export interface ExportResult {
  format: ExportFormat;
  outputPath: string;
  metadataPath: string | null;
  trajectoryCode: string | null;
  totalFiles: number;
  totalBytes: number;
  elapsedMs: number;
  range: ExportRange;
  stateCount: number;
}

export interface BatchExportItemResult {
  episodeId: string;
  trajectoryCode: string;
  sourcePath: string;
  status: "exported" | "failed";
  validationStatus: "ok" | "warning" | "error" | null;
  result: ExportResult | null;
  error: string | null;
  errorLogPath: string | null;
}

export interface BatchExportResult {
  format: ExportFormat;
  destinationParent: string;
  requestedCount: number;
  exportedCount: number;
  failedCount: number;
  cancelled: boolean;
  totalFiles: number;
  totalBytes: number;
  elapsedMs: number;
  items: BatchExportItemResult[];
}

export type MetricKey = "position" | "velocity" | "euler" | "omega";
