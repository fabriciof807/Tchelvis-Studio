use serde::{Deserialize, Serialize};

/// Global application configuration loaded from `~/.config/game-hub/config.toml`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GlobalConfig {
    pub general: GeneralConfig,
    pub webkitgtk: WebkitGtkConfig,
    pub compositor: CompositorConfig,
    pub preview: PreviewConfig,
    pub sidecar: SidecarConfig,
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
                dpi_backend_bin: "dpi-backend".to_string(),
                tchelvis_bin: "tchelvis".to_string(),
            },
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
    pub workflow: String,
    pub status: String,
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

/// Acknowledgement returned by `pi_send_message`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PiTurnAck {
    pub turn_id: String,
    pub mode: String,
    pub reply_text: String,
    pub tool_calls: Vec<String>,
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

/// State of a Tchelvis loop run read from `.loops/runs/*/state.json`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LoopRunState {
    pub run_id: String,
    pub workflow: String,
    pub title: String,
    pub status: String,
    pub current_stage: String,
    pub stages: Vec<String>,
    pub worktree_path: Option<String>,
    pub exit_summary: Vec<String>,
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

/// Result of checking whether a loop worktree can be cleanly merged.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct MergeCheckResult {
    pub can_merge: bool,
    pub conflicting_dirty_files: Vec<String>,
    pub worktree_path: String,
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
    pub output_log: String,
}
