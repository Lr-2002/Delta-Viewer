use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const STREAM_NAMES: [&str; 5] = ["cam0", "cam1", "cam2", "t265_left", "t265_right"];
pub const VALIDATION_REPORT_FORMAT_VERSION: u32 = 7;
pub const EXPECTED_STATE_FRAME_RATE_FPS: u32 = 30;
pub const STATE_FRAME_RATE_TOLERANCE_PERCENT: u8 = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserIdentity {
    pub username: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionUserSummary {
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub assigned_tasks: u64,
    #[serde(default)]
    pub assigned_task_names: Vec<String>,
    #[serde(default)]
    pub assigned_task_quantities: BTreeMap<String, u64>,
    pub completed_today: u64,
    pub total_completed: u64,
    pub average_completion_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionEvent {
    pub event_id: String,
    pub username: String,
    pub display_name: String,
    pub task_id: String,
    pub trajectory_code: String,
    pub action: String,
    pub occurred_at_ms: u64,
    pub received_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionAccount {
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub assigned_tasks: u64,
    #[serde(default)]
    pub assigned_task_names: Vec<String>,
    #[serde(default)]
    pub assigned_task_quantities: BTreeMap<String, u64>,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionDashboardData {
    pub users: Vec<SupervisionUserSummary>,
    pub events: Vec<SupervisionEvent>,
    pub accounts: Vec<SupervisionAccount>,
    pub task_details: Vec<SupervisionTaskDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionTaskDetail {
    pub task: String,
    pub detail: String,
    pub source: String,
    pub updated_at_ms: u64,
    pub updated_by: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionTaskImportResult {
    pub task_details: Vec<SupervisionTaskDetail>,
    pub imported_task_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignedTask {
    pub task: String,
    pub detail: String,
    pub quantity: u64,
    pub start_index: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignedTaskActivity {
    pub date: String,
    pub events: Vec<SupervisionEvent>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionTaskSummary {
    pub task: String,
    pub completed: u64,
    pub total: u64,
    pub completed_frames: u64,
    pub total_frames: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionTaskCatalog {
    pub source_path: String,
    pub tasks: Vec<SupervisionTaskSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionAnnotationCatalog {
    pub source_name: String,
    pub users: Vec<SupervisionAnnotationUserSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionAnnotationUserSummary {
    pub username: String,
    pub display_name: String,
    pub trajectory_count: u64,
    pub segment_count: u64,
    pub annotated_frame_count: u64,
    pub tasks: Vec<SupervisionAnnotationTaskSummary>,
    pub entries: Vec<SupervisionAnnotationEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionAnnotationTaskSummary {
    pub task_id: String,
    pub trajectory_count: u64,
    pub segment_count: u64,
    pub annotated_frame_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionAnnotationEntry {
    pub task_id: String,
    pub trajectory_code: String,
    pub revision: u64,
    pub segment_count: u64,
    pub annotated_frame_count: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub workspace_mode: Option<WorkspaceMode>,
    pub user_center: UserCenterStatus,
    pub current_user: Option<UserIdentity>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceMode {
    Managed,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserCenterStatus {
    pub configured: bool,
    pub endpoint: Option<String>,
    pub service_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationAuditRequest {
    pub task_id: String,
    pub trajectory_code: String,
    pub action: String,
    pub occurred_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinition {
    pub id: String,
    pub label: String,
    pub code_prefix: String,
    pub default_description: String,
    #[serde(default)]
    pub description_options: Vec<String>,
    #[serde(default)]
    pub default_segments: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTaskRequest {
    pub label: String,
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
    #[serde(default)]
    pub edit_started_at_ms: u64,
    #[serde(default)]
    pub edit_duration_ms: u64,
    #[serde(default)]
    pub clip_start_frame: Option<u64>,
    #[serde(default)]
    pub clip_end_frame: Option<u64>,
    #[serde(default)]
    pub segments: Vec<SegmentAnnotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentAnnotation {
    pub start_frame: u64,
    pub end_frame: u64,
    pub title: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotatedEpisodeSummary {
    pub annotation: EpisodeAnnotation,
    pub source_available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveAnnotationRequest {
    pub source_path: String,
    pub task_id: String,
    pub task_description: String,
    pub edit_started_at_ms: u64,
    #[serde(default)]
    pub clip_start_frame: Option<u64>,
    #[serde(default)]
    pub clip_end_frame: Option<u64>,
    #[serde(default)]
    pub segments: Vec<SegmentAnnotation>,
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
    pub indexed: bool,
    pub total_files: u64,
    pub total_bytes: u64,
    pub state_count: u64,
    pub start_time_ns: Option<String>,
    pub end_time_ns: Option<String>,
    pub streams: Vec<StreamSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeValidationResult {
    pub report: ValidationReport,
    pub summary: EpisodeSummary,
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

#[derive(Debug, Clone)]
pub struct RawStateRecord {
    pub frame_id: i64,
    pub capture_time_ns: i64,
    pub position: Option<[Option<f64>; 3]>,
    pub velocity: [f64; 3],
    pub quaternion: [f64; 4],
    pub euler: [f64; 3],
    pub omega: [f64; 3],
    pub confidence: f64,
}

impl<'de> Deserialize<'de> for RawStateRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct PoseRecord {
            #[serde(default)]
            position: Option<[Option<f64>; 3]>,
            #[serde(default)]
            velocity: [f64; 3],
            #[serde(default)]
            quaternion: [f64; 4],
            #[serde(default)]
            euler: [f64; 3],
            #[serde(default)]
            omega: [f64; 3],
            #[serde(default)]
            confidence: f64,
        }

        #[derive(Deserialize)]
        struct CompatibleStateRecord {
            #[serde(default)]
            frame_id: Option<i64>,
            #[serde(default)]
            batch_id: Option<i64>,
            capture_time_ns: i64,
            #[serde(default)]
            position: Option<[Option<f64>; 3]>,
            #[serde(default)]
            velocity: [f64; 3],
            #[serde(default)]
            quaternion: [f64; 4],
            #[serde(default)]
            euler: [f64; 3],
            #[serde(default)]
            omega: [f64; 3],
            #[serde(default)]
            confidence: f64,
            #[serde(default)]
            pose: Option<PoseRecord>,
        }

        let value = CompatibleStateRecord::deserialize(deserializer)?;
        let frame_id = value
            .frame_id
            .or(value.batch_id)
            .ok_or_else(|| serde::de::Error::missing_field("frame_id or batch_id"))?;
        let pose = value.pose;
        Ok(Self {
            frame_id,
            capture_time_ns: value.capture_time_ns,
            position: pose
                .as_ref()
                .and_then(|item| item.position)
                .or(value.position),
            velocity: pose.as_ref().map_or(value.velocity, |item| item.velocity),
            quaternion: pose
                .as_ref()
                .map_or(value.quaternion, |item| item.quaternion),
            euler: pose.as_ref().map_or(value.euler, |item| item.euler),
            omega: pose.as_ref().map_or(value.omega, |item| item.omega),
            confidence: pose.map_or(value.confidence, |item| item.confidence),
        })
    }
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
            position: value
                .position
                .unwrap_or([None; 3])
                .map(|component| component.unwrap_or_default()),
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
    pub skeleton: Option<SkeletonSeries>,
    pub skeleton_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkeletonFrame {
    pub frame_id: i64,
    pub joints: Vec<[f32; 3]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkeletonSeries {
    pub source_name: String,
    pub frame_count: u64,
    pub joint_count: u64,
    pub frames: Vec<SkeletonFrame>,
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
pub struct StateFrameRate {
    pub expected_fps: u32,
    pub measured_fps: Option<f64>,
    pub tolerance_percent: u8,
    pub interval_count: u64,
    pub stability_percent: Option<f64>,
    pub stable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub format_version: u32,
    pub episode_root: String,
    pub parsed_state_count: u64,
    pub image_validation_mode: ImageValidationMode,
    pub image_sample_percentages: Vec<u8>,
    pub state_frame_rate: StateFrameRate,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressEvent {
    #[serde(flatten)]
    pub progress: ProgressPayload,
    pub operation_id: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub notes: Option<String>,
    pub published_at: Option<String>,
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
    pub validation_report: Option<ValidationReport>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordOperationErrorRequest {
    pub operation: String,
    pub message: String,
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationErrorRecord {
    pub format_version: u32,
    pub id: String,
    pub occurred_at_ms: u64,
    pub operation: String,
    pub code: String,
    pub message: String,
    pub source_path: Option<String>,
    pub processed_by: UserIdentity,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePayload {
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSource {
    pub fps: f64,
    pub segment_seconds: f64,
    pub paths: Vec<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchExportCommandRequest {
    pub episode_ids: Vec<String>,
    pub destination_parent: String,
    pub format: ExportFormat,
    pub acknowledge_warnings: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub format: String,
    pub output_path: String,
    pub metadata_path: Option<String>,
    pub trajectory_code: Option<String>,
    pub total_files: u64,
    pub total_bytes: u64,
    pub elapsed_ms: u128,
    pub range: ExportRange,
    pub state_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportItemResult {
    pub episode_id: String,
    pub trajectory_code: String,
    pub source_path: String,
    pub status: String,
    pub validation_status: Option<String>,
    pub result: Option<ExportResult>,
    pub error: Option<String>,
    pub error_log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportResult {
    pub format: String,
    pub destination_parent: String,
    pub requested_count: u64,
    pub exported_count: u64,
    pub failed_count: u64,
    pub cancelled: bool,
    pub total_files: u64,
    pub total_bytes: u64,
    pub elapsed_ms: u128,
    pub items: Vec<BatchExportItemResult>,
}
