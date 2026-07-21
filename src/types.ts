export type TaskName = "scan" | "import" | "validate" | "export";

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

export interface EpisodeData {
  summary: EpisodeSummary;
  states: StateRecord[];
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

export interface ValidationReport {
  formatVersion: number;
  episodeRoot: string;
  parsedStateCount: number;
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

export interface ExportRange {
  startFrame: number;
  endFrame: number;
}

export interface ExportResult {
  format: ExportFormat;
  outputPath: string;
  totalFiles: number;
  totalBytes: number;
  elapsedMs: number;
  range: ExportRange;
  stateCount: number;
}

export type MetricKey = "position" | "velocity" | "euler" | "omega";
