use serde::{Deserialize, Serialize};

/// Global application configuration loaded from `~/.config/game-hub/config.toml`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GlobalConfig {
    pub general: GeneralConfig,
    pub webkitgtk: WebkitGtkConfig,
    pub compositor: CompositorConfig,
    pub preview: PreviewConfig,
    pub sidecar: SidecarConfig,
    #[serde(default)]
    pub image_generation: ImageGenerationConfig,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(default)]
pub struct ImageGenerationConfig {
    /// Primary backend: "flow_browser" (default) | "gemini_api"
    pub backend: String,
    /// Target URL for Google Flow
    pub flow_url: String,
    /// Optional fallback backend when primary fails or desktop webview is unavailable
    pub fallback_backend: Option<String>,
    /// Gemini image generation model used when backend/fallback is "gemini_api"
    pub gemini_model: String,
    /// Default timeout in seconds for Flow generation jobs
    pub timeout_secs: u64,
    /// Optional custom path for persistent WebView profile directory
    pub webview_data_dir: Option<String>,
}

impl Default for ImageGenerationConfig {
    fn default() -> Self {
        Self {
            backend: "flow_browser".to_string(),
            flow_url: "https://labs.google/fx/tools/flow".to_string(),
            fallback_backend: Some("gemini_api".to_string()),
            gemini_model: "gemini-2.5-flash-image-preview".to_string(),
            timeout_secs: 90,
            webview_data_dir: None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GeneralConfig {
    pub external_browser: String,
    pub capture_quota_bytes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WebkitGtkConfig {
    pub disable_dmabuf_renderer: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CompositorConfig {
    pub backend: String,
    pub preview_width: u32,
    pub preview_height: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PreviewConfig {
    pub vite_port_start: u16,
    pub vite_port_end: u16,
    pub healthcheck_timeout_ms: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SidecarConfig {
    pub dpi_backend_bin: String,
    pub tchelvis_bin: String,
}

impl Default for GlobalConfig {
    fn default() -> Self {
        Self {
            general: GeneralConfig {
                external_browser: "xdg-open".to_string(),
                capture_quota_bytes: 200 * 1024 * 1024,
            },
            webkitgtk: WebkitGtkConfig {
                disable_dmabuf_renderer: true,
            },
            compositor: CompositorConfig {
                backend: "auto".to_string(),
                preview_width: 1280,
                preview_height: 720,
            },
            preview: PreviewConfig {
                vite_port_start: 4173,
                vite_port_end: 4199,
                healthcheck_timeout_ms: 10_000,
            },
            sidecar: SidecarConfig {
                dpi_backend_bin: "pi".to_string(),
                tchelvis_bin: "tchelvis".to_string(),
            },
            image_generation: ImageGenerationConfig::default(),
        }
    }
}

/// Metadata stored in `.hub/project.json`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ProjectConfig {
    pub schema_version: u32,
    pub engine: String,
    pub game_dir: String,
    pub default_branch: String,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            engine: "godot".to_string(),
            game_dir: "game".to_string(),
            default_branch: "main".to_string(),
        }
    }
}

/// Information returned when opening a workspace.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WorkspaceInfo {
    pub root_path: String,
    pub name: String,
    pub is_uninitialized: bool,
    pub project_config: Option<ProjectConfig>,
    pub orphan_worktrees: Vec<String>,
    pub offline_completed_runs: Vec<LoopRunState>,
}

/// Entry stored in `~/.config/game-hub/recent.json`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct RecentWorkspace {
    pub path: String,
    pub name: String,
    pub last_opened: String,
}

/// Recursive file tree node for the workspace explorer.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct FileTreeNode {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub children: Vec<FileTreeNode>,
}

/// Payload returned when reading a Markdown file.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct MarkdownFilePayload {
    pub rel_path: String,
    pub content: String,
    pub sha256: String,
}

/// Result returned after writing a Markdown file.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct WriteMarkdownResult {
    pub rel_path: String,
    pub sha256: String,
}

/// Reference to the latest loop run for ambient context.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LatestLoopRef {
    pub run_id: String,
    #[serde(default)]
    pub workflow: String,
    pub status: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// Active UI context injected into each Pi Durable turn.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ActiveContext {
    pub focused_panel: String,
    pub open_tabs: Vec<String>,
    pub dirty_files: Vec<String>,
    pub latest_loop: Option<LatestLoopRef>,
}

/// One-shot attachment consumed when sending a Pi Durable message.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OneShotAttachment {
    pub r#type: String,
    pub source_url: Option<String>,
    pub image_path: String,
    pub user_note: Option<String>,
}

/// Ambient envelope sent to `pi_send_message`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct AmbientEnvelope {
    pub user_message: String,
    pub active_context: ActiveContext,
    pub one_shot_attachments: Vec<OneShotAttachment>,
}

/// Tool call entry emitted during a Pi Durable turn.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PiToolCall {
    pub id: String,
    pub name: String,
    pub arguments_json: String,
    #[serde(default)]
    pub result_json: Option<String>,
    pub status: String,
}

/// Acknowledgement returned by `pi_send_message`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PiTurnAck {
    pub turn_id: String,
    pub mode: String,
    pub reply_text: String,
    pub tool_calls: Vec<PiToolCall>,
}

/// Result returned by `save_capture`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CaptureSaved {
    pub rel_path: String,
    pub total_captures_bytes: u64,
    pub quota_exceeded: bool,
}

/// Metadata for a read-only custom lens in `.hub/views/`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LensInfo {
    pub lens_id: String,
    pub title: String,
    pub rel_path: String,
}

/// Execution stage inside a Tchelvis loop run.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct LoopStage {
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub cycle: Option<u32>,
    pub status: String,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

/// State of a Tchelvis loop run read from `.loops/runs/*/state.json`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LoopRunState {
    pub run_id: String,
    pub workflow: String,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub raw_status: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub current_stage: Option<String>,
    #[serde(default)]
    pub current_cycle: Option<u32>,
    #[serde(default)]
    pub max_cycles: Option<u32>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub stages: Vec<LoopStage>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub engine_pid: Option<u32>,
}

/// Workflow preset or local `.loops/workflows/*.toml` entry returned by `tchelvis loop list`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LoopWorkflowInfo {
    pub name: String,
    pub source: String,
    pub description: String,
}

/// Result returned by `tchelvis loop check`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LoopCheckResult {
    pub ok: bool,
    pub tchelvis_available: bool,
    pub auto_approve_enabled: Option<bool>,
    pub workflow: String,
    pub output: String,
}

/// Optional flags passed when dispatching a `tchelvis loop run`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(default)]
pub struct DispatchLoopOptions {
    pub use_overrides: Vec<String>,
    pub max_cycles: Option<u32>,
    pub from_head: bool,
}

/// Status of the active game/web preview process.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PreviewStatus {
    pub active: bool,
    pub mode: String,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub pid: Option<u32>,
    pub degraded_reason: Option<String>,
}

/// Result of capturing a preview frame + log tail.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CaptureResult {
    pub image_path: Option<String>,
    pub log_tail: Vec<String>,
    pub error: Option<String>,
}

/// Result of checking whether a loop branch/worktree can be cleanly merged.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct MergeCheckResult {
    pub can_merge: bool,
    pub can_merge_cleanly: bool,
    pub dirty_files: Vec<String>,
    pub colliding_files: Vec<String>,
    pub conflicting_dirty_files: Vec<String>,
    pub requires_stash: bool,
    pub worktree_path: Option<String>,
    pub branch: String,
}

/// Result of merging a loop worktree into `default_branch`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct MergeResult {
    pub merged: bool,
    pub stashed: bool,
    pub cleaned_worktree: bool,
    pub message: String,
}

/// Event payload emitted on `pi://event`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PiStreamEvent {
    pub event_type: String,
    pub turn_id: String,
    pub payload: serde_json::Value,
}

/// Result of checking the update channel (`stable` or `nightly`) against GitHub.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct UpdateCheckResult {
    pub channel: String,
    pub source: String,
    pub repo_dir: String,
    pub branch: String,
    pub release_tag: Option<String>,
    pub current_commit: String,
    pub remote_commit: String,
    pub commits_behind: u32,
    pub update_available: bool,
    pub has_prebuilt_asset: bool,
    pub changelog: Vec<String>,
}

/// Result of downloading a CI/CD release or pulling and rebuilding locally.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct UpdateApplyResult {
    pub channel: String,
    pub source: String,
    pub updated: bool,
    pub new_commit: String,
    pub release_tag: Option<String>,
    pub message: String,
    pub changelog: Vec<String>,
    pub output_log: String,
}

/// Request payload for `dispatch_flow_generation`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct FlowGenerationRequest {
    pub prompt: String,
    pub save_path: String,
    pub aspect_ratio: Option<String>,
    pub timeout_secs: Option<u64>,
}

/// Metadata returned when `dispatch_flow_generation` succeeds.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct FlowGenerationResult {
    pub job_id: String,
    pub status: String,
    pub saved_path: String,
    pub byte_size: u64,
    pub sha256: String,
    pub markdown_embed: String,
    pub obsidian_embed: String,
    pub backend_used: String,
}

/// Callback payload delivered by the WebView bridge or headless test runner to `flow_bridge_result`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct FlowBridgeCallbackPayload {
    pub job_id: String,
    pub token: Option<String>,
    pub status: String,
    pub image_base64: Option<String>,
    pub image_bytes: Option<Vec<u8>>,
    pub mime_type: Option<String>,
    pub error: Option<String>,
}

/// Logical viewport bounds of the embedded BrowserPanel relative to the main window client area.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for BrowserBounds {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        }
    }
}

/// Current state of the embedded BrowserPanel child WebView.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct BrowserPanelState {
    pub initialized: bool,
    pub url: String,
    pub title: String,
    pub visible: bool,
    pub loading: bool,
    pub bounds: BrowserBounds,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

/// Result returned by `browser_capture_snapshot`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct BrowserSnapshotResult {
    pub data_url: Option<String>,
    pub width: u32,
    pub height: u32,
    pub backend: String,
    pub fallback_reason: Option<String>,
}

/// Catalog entry for a Pi Durable LLM provider.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PiProviderCatalogEntry {
    pub id: String,
    pub label: String,
    pub supports_api_key: bool,
    pub supports_oauth: bool,
    pub configured: bool,
    pub auth_type: Option<String>,
    pub env_var_hint: Option<String>,
    pub suggested_models: Vec<String>,
}

/// Current first-run and provider readiness status for Pi Durable.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PiSetupStatus {
    pub pi_available: bool,
    pub pi_bin: Option<String>,
    pub first_run_completed: bool,
    pub needs_setup: bool,
    pub active_provider: Option<String>,
    pub active_model: Option<String>,
    pub provider_ready: bool,
    pub configured_providers: Vec<String>,
    pub providers: Vec<PiProviderCatalogEntry>,
    pub available_models: Vec<String>,
}

/// One model pi can use. Deliberately omits `baseUrl`, headers and any credential material.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PiModelInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub image_input: bool,
    pub context_window: Option<u64>,
    pub max_output: Option<u64>,
    /// USD per million input tokens, when pi knows it.
    pub cost_in: Option<f64>,
    /// USD per million output tokens, when pi knows it.
    pub cost_out: Option<f64>,
}

/// Result of `pi_list_models`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PiModelCatalog {
    /// Where the list came from: `pi_rpc`, `models_store` or `curated`.
    pub source: String,
    pub models: Vec<PiModelInfo>,
    /// Why the preferred source (`pi_rpc`) was not used; `None` when it was.
    pub fallback_reason: Option<String>,
}

/// Request payload for `pi_configure_provider`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(default)]
pub struct PiConfigureProviderRequest {
    pub provider: String,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub mark_completed: bool,
}

/// Result returned by `pi_check_provider` (`pi auth check --provider <p> --no-refresh --json`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PiAuthCheckResult {
    pub status: String,
    pub provider: String,
    pub auth_type: Option<String>,
    pub reason: Option<String>,
}
