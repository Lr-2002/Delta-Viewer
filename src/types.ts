export type TaskName = "scan" | "import" | "validate" | "export";

export interface StreamSummary {
  name: string;
  label: string;
  frameCount: number;
  firstFrame: number | null;
  lastFrame: number | null;
  missingFrames: number[];
  totalBytes: number;
  width: number | null;
  height: number | null;
  channels: number | null;
}

export interface EpisodeSummary {
  root: string;
  name: string;
  totalFiles: number;
  totalBytes: number;
  stateCount: number;
  startTimeNs: string | null;
  endTimeNs: string | null;
  streams: StreamSummary[];
}

export interface ScanResult {
  sourceRoot: string;
  episodes: EpisodeSummary[];
  totalFiles: number;
  totalBytes: number;
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

export interface EpisodeData {
  summary: EpisodeSummary;
  states: StateRecord[];
}

export type Severity = "info" | "warning" | "error";

export interface ValidationIssue {
  severity: Severity;
  code: string;
  scope: string;
  message: string;
}

export interface StreamValidation {
  name: string;
  checkedFrames: number;
  decodeFailures: number;
  status: "ok" | "warning" | "error";
}

export interface ValidationReport {
  status: "ok" | "warning" | "error";
  checkedFiles: number;
  elapsedMs: number;
  issues: ValidationIssue[];
  streams: StreamValidation[];
}

export interface TaskProgress {
  task: TaskName;
  phase: string;
  current: number;
  total: number;
  bytesDone: number;
  totalBytes: number;
  currentPath: string;
  elapsedMs: number;
}

export interface ImportResult {
  destination: string;
  totalFiles: number;
  totalBytes: number;
  datasetBlake3: string;
  elapsedMs: number;
}

export type ExportFormat = "mcap" | "hdf5" | "lerobot_v2";

export interface ExportResult {
  format: ExportFormat;
  outputPath: string;
  totalFiles: number;
  totalBytes: number;
  elapsedMs: number;
}

export type MetricKey = "position" | "velocity" | "euler" | "omega";
