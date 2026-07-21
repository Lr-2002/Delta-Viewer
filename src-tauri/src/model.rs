use serde::{Deserialize, Serialize};

pub const STREAM_NAMES: [&str; 5] = ["cam0", "cam1", "cam2", "t265_left", "t265_right"];
pub const VALIDATION_REPORT_FORMAT_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserIdentity {
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub has_accounts: bool,
    pub current_user: Option<UserIdentity>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterAccountRequest {
    pub username: String,
    pub display_name: String,
    pub password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinition {
    pub id: String,
    pub label: String,
    pub code_prefix: String,
    pub default_description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeAnnotation {
    pub format_version: u32,
    pub episode_id: String,
    pub episode_root: String,
    pub episode_fingerprint: String,
    pub trajectory_code: String,
    pub task_id: String,
    pub task_description: String,
    pub processed_by: UserIdentity,
    pub revision: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveAnnotationRequest {
    pub source_path: String,
    pub trajectory_code: String,
    pub task_id: String,
    pub task_description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSummary {
    pub name: String,
    pub label: String,
    pub frame_count: u64,
    pub first_frame: Option<u64>,
    pub last_frame: Option<u64>,
    pub missing_frames: Vec<u64>,
    pub missing_frame_count: u64,
    pub total_bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub channels: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeSummary {
    pub root: String,
    pub name: String,
    pub total_files: u64,
    pub total_bytes: u64,
    pub state_count: u64,
    pub start_time_ns: Option<String>,
    pub end_time_ns: Option<String>,
    pub streams: Vec<StreamSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub source_root: String,
    pub episodes: Vec<EpisodeSummary>,
    pub total_files: u64,
    pub total_bytes: u64,
    pub volume: VolumeInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub root: String,
    pub filesystem: Option<String>,
    pub drive_type: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightIssue {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialImport {
    pub path: String,
    pub name: String,
    pub source_name: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreflight {
    pub can_import: bool,
    pub source_bytes: u64,
    pub required_bytes: u64,
    pub largest_file_bytes: u64,
    pub volume: VolumeInfo,
    pub issues: Vec<PreflightIssue>,
    pub partials: Vec<PartialImport>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawStateRecord {
    pub frame_id: i64,
    pub capture_time_ns: i64,
    pub position: [f64; 3],
    pub velocity: [f64; 3],
    pub quaternion: [f64; 4],
    pub euler: [f64; 3],
    pub omega: [f64; 3],
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateRecord {
    pub frame_id: i64,
    pub capture_time_ns: String,
    pub position: [f64; 3],
    pub velocity: [f64; 3],
    pub quaternion: [f64; 4],
    pub euler: [f64; 3],
    pub omega: [f64; 3],
    pub confidence: f64,
}

impl From<RawStateRecord> for StateRecord {
    fn from(value: RawStateRecord) -> Self {
        Self {
            frame_id: value.frame_id,
            capture_time_ns: value.capture_time_ns.to_string(),
            position: value.position,
            velocity: value.velocity,
            quaternion: value.quaternion,
            euler: value.euler,
            omega: value.omega,
            confidence: value.confidence,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeData {
    pub summary: EpisodeSummary,
    pub states: Vec<StateRecord>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageValidationMode {
    Sampled,
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub severity: Severity,
    pub code: String,
    pub scope: String,
    pub message: String,
    pub frame_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamValidation {
    pub name: String,
    pub checked_frames: u64,
    pub decode_failures: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub format_version: u32,
    pub episode_root: String,
    pub parsed_state_count: u64,
    pub image_validation_mode: ImageValidationMode,
    pub image_sample_percentages: Vec<u8>,
    pub auto_report_path: Option<String>,
    pub status: String,
    pub checked_files: u64,
    pub elapsed_ms: u128,
    pub issues: Vec<ValidationIssue>,
    pub streams: Vec<StreamValidation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportExportResult {
    pub output_path: String,
    pub total_bytes: u64,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub task: String,
    pub phase: String,
    pub current: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub total_bytes: u64,
    pub current_path: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub path: String,
    pub source_path: String,
    pub size: u64,
    pub blake3: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportManifest {
    pub format_version: u32,
    pub source_name: String,
    pub total_files: u64,
    pub total_bytes: u64,
    pub dataset_blake3: String,
    pub files: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub destination: String,
    pub total_files: u64,
    pub total_bytes: u64,
    pub dataset_blake3: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePayload {
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Mcap,
    Hdf5,
    LerobotV2,
}

impl ExportFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mcap => "mcap",
            Self::Hdf5 => "hdf5",
            Self::LerobotV2 => "lerobot_v2",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportRange {
    pub start_frame: u64,
    pub end_frame: u64,
}

impl ExportRange {
    pub fn contains(self, frame_id: u64) -> bool {
        frame_id >= self.start_frame && frame_id <= self.end_frame
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCommandRequest {
    pub source_path: String,
    pub destination_parent: String,
    pub format: ExportFormat,
    pub acknowledge_warnings: bool,
    pub range: Option<ExportRange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub format: String,
    pub output_path: String,
    pub trajectory_code: Option<String>,
    pub total_files: u64,
    pub total_bytes: u64,
    pub elapsed_ms: u128,
    pub range: ExportRange,
    pub state_count: u64,
}
