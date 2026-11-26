pub mod browser_panel;
pub mod compositor;
pub mod flow_bridge;
pub mod fs_watcher;
pub mod git_ops;
pub mod preview;
pub mod pty;
pub mod sidecar;
pub mod types;
pub mod updater;
pub mod workspace;

use compositor::{CompositorAdapter, HyprlandCompositorAdapter};
use fs_watcher::{
    list_loop_runs, read_loop_report, reconcile_offline_completed_runs, EchoSuppressionCache,
    LoopStateCache, WorkspaceWatcher,
};
use preview::{PreviewLauncher, PreviewManager, SystemPreviewLauncher};
use pty::PtyManager;
use sidecar::{
    create_pi_adapter, list_lenses, publish_lens, read_lens_html, ControlSocket,
    DefaultTchelvisAdapter, PiCancelToken, PiDirs, PiSidecarAdapter, TchelvisAdapter,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use types::{
    AmbientEnvelope, BrowserBounds, BrowserPanelState, BrowserSnapshotResult, CaptureResult,
    CaptureSaved, DispatchLoopOptions, FileTreeNode, FlowBridgeCallbackPayload,
    FlowGenerationResult, GlobalConfig, HubWindowRect, LensInfo, LoopCheckResult, LoopRunState,
    LoopWorkflowInfo, MarkdownFilePayload, MergeCheckResult, MergeResult, PiAuthCheckResult,
    PiConfigureProviderRequest, PiConnectProviderRequest, PiConnectResult, PiModelCatalog,
    PiSetupStatus, PiTurnAck, PreviewEngine, PreviewStatus, ProjectConfig, RecentWorkspace,
    UpdateApplyResult, UpdateCheckResult, WorkspaceInfo, WriteMarkdownResult,
};

/// Shared microkernel state used by both headless tests and Tauri desktop IPC.
pub struct AppState {
    pub workspace_root: Mutex<Option<PathBuf>>,
    pub project_config: Mutex<Option<ProjectConfig>>,
    pub global_config: Mutex<GlobalConfig>,
    pub echo_cache: Arc<Mutex<EchoSuppressionCache>>,
    pub loop_state_cache: Mutex<LoopStateCache>,
    pub pty_manager: PtyManager,
    pub pi_adapter: Mutex<Box<dyn PiSidecarAdapter>>,
    /// Stops a running turn without waiting for `pi_adapter`, which the turn holds for its whole length.
    pub pi_cancel: PiCancelToken,
    /// Pi directories for the setup commands; `None` uses `default_pi_agent_dir()`/`config_dir()`.
    pub pi_dirs: Option<PiDirs>,
    pub tchelvis: Box<dyn TchelvisAdapter>,
    pub preview_manager: Mutex<PreviewManager>,
    pub preview_launcher: Box<dyn PreviewLauncher>,
    pub compositor: Box<dyn CompositorAdapter>,
    pub watcher: Mutex<Option<WorkspaceWatcher>>,
    pub control_socket: Mutex<Option<ControlSocket>>,
    pub flow_bridge: Arc<flow_bridge::FlowBridgeManager>,
    pub browser_panel: Arc<browser_panel::BrowserPanelManager>,
}

impl AppState {
    pub fn new(global_config: GlobalConfig) -> Self {
        let pi_cancel = PiCancelToken::default();
        let pi_adapter = create_pi_adapter(&global_config.sidecar.dpi_backend_bin, &pi_cancel);
        let tchelvis = Box::new(DefaultTchelvisAdapter {
            bin_name: global_config.sidecar.tchelvis_bin.clone(),
        });
        let compositor = HyprlandCompositorAdapter::detect();
        let control_socket = ControlSocket::bind().ok();
        let echo_cache = Arc::new(Mutex::new(EchoSuppressionCache::default()));
        let flow_bridge = Arc::new(flow_bridge::FlowBridgeManager::new(Arc::clone(&echo_cache)));
        let browser_panel = Arc::new(browser_panel::BrowserPanelManager::new());

        Self {
            workspace_root: Mutex::new(None),
            project_config: Mutex::new(None),
            global_config: Mutex::new(global_config),
            echo_cache,
            loop_state_cache: Mutex::new(LoopStateCache::default()),
            pty_manager: PtyManager::new(),
            pi_adapter: Mutex::new(pi_adapter),
            pi_cancel,
            pi_dirs: None,
            tchelvis,
            preview_manager: Mutex::new(PreviewManager::new()),
            preview_launcher: Box::new(SystemPreviewLauncher),
            compositor,
            watcher: Mutex::new(None),
            control_socket: Mutex::new(control_socket),
            flow_bridge,
            browser_panel,
        }
    }

    pub fn active_root(&self) -> Result<PathBuf, String> {
        self.workspace_root
            .lock()
            .map_err(|_| "workspace_root mutex poisoned".to_string())?
            .clone()
            .ok_or_else(|| "no workspace is currently open".to_string())
    }

    pub fn default_branch(&self) -> String {
        self.project_config
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|c| c.default_branch.clone()))
            .unwrap_or_else(|| "main".to_string())
    }

    pub fn game_dir(&self) -> String {
        self.project_config
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|c| c.game_dir.clone()))
            .unwrap_or_else(|| "game".to_string())
    }

    /// The configured preview engine, or `None` when `.hub/project.json` does not name one.
    pub fn project_engine(&self) -> Option<String> {
        self.project_config
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|c| c.engine.clone()))
    }
}

impl AppState {
    /// Cancels any running turn first, so this never blocks behind it on the adapter lock.
    pub fn shutdown_pi(&self) {
        self.pi_cancel.cancel();
        if let Ok(mut pi) = self.pi_adapter.lock() {
            pi.shutdown();
        }
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Ok(mut pm) = self.preview_manager.lock() {
            pm.stop();
        }
        self.pty_manager.kill_all();
        self.shutdown_pi();
        if let Ok(root_guard) = self.workspace_root.lock() {
            if let Some(root) = root_guard.as_ref() {
                workspace::release_workspace_lock(root);
            }
        }
    }
}

pub fn cmd_open_workspace(state: &AppState, path: String) -> Result<WorkspaceInfo, String> {
    let target = PathBuf::from(&path);
    if !target.is_dir() {
        return Err(format!("workspace path is not a directory: {path}"));
    }
    let canonical = std::fs::canonicalize(&target)
        .map_err(|e| format!("failed to canonicalize workspace path: {e}"))?;

    // Release previous workspace resources if switching.
    if let Ok(mut pm) = state.preview_manager.lock() {
        pm.stop();
    }
    state.pty_manager.kill_all();
    state.shutdown_pi();
    if let Ok(mut w) = state.watcher.lock() {
        *w = None;
    }
    if let Ok(prev) = state.workspace_root.lock() {
        if let Some(prev_root) = prev.as_ref() {
            workspace::release_workspace_lock(prev_root);
        }
    }

    let is_uninitialized = workspace::is_workspace_uninitialized(&canonical)?;

    let sock_path = state
        .control_socket
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.socket_path.clone()))
        .unwrap_or_else(|| PathBuf::from("headless.sock"));

    workspace::acquire_workspace_lock(&canonical, &sock_path)?;
    let project_config = workspace::read_project_config(&canonical)?;
    let orphan_worktrees = git_ops::list_orphan_worktrees(&canonical).unwrap_or_default();
    let offline_completed_runs = {
        let mut cache = state
            .loop_state_cache
            .lock()
            .map_err(|_| "loop_state_cache poisoned".to_string())?;
        reconcile_offline_completed_runs(&canonical, &mut cache).unwrap_or_default()
    };

    if let Ok(cfg_dir) = workspace::config_dir() {
        let _ = workspace::record_recent_workspace_in(&cfg_dir, &canonical);
    }

    *state
        .workspace_root
        .lock()
        .map_err(|_| "workspace_root poisoned".to_string())? = Some(canonical.clone());
    *state
        .project_config
        .lock()
        .map_err(|_| "project_config poisoned".to_string())? = project_config.clone();

    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();

    Ok(WorkspaceInfo {
        root_path: canonical.to_string_lossy().to_string(),
        name,
        is_uninitialized,
        project_config,
        orphan_worktrees,
        offline_completed_runs,
    })
}

pub fn cmd_list_recent_workspaces() -> Result<Vec<RecentWorkspace>, String> {
    let cfg_dir = workspace::config_dir()?;
    workspace::list_recent_workspaces_in(&cfg_dir)
}

pub fn cmd_get_workspace_tree(state: &AppState) -> Result<Vec<FileTreeNode>, String> {
    let root = state.active_root()?;
    workspace::build_workspace_tree(&root)
}

pub fn cmd_read_markdown_file(
    state: &AppState,
    rel_path: String,
) -> Result<MarkdownFilePayload, String> {
    let root = state.active_root()?;
    workspace::read_markdown_file(&root, &rel_path)
}

pub fn cmd_read_binary_file(state: &AppState, rel_path: String) -> Result<String, String> {
    let root = state.active_root()?;
    workspace::read_binary_file_base64(&root, &rel_path)
}

pub fn cmd_write_markdown_file(
    state: &AppState,
    rel_path: String,
    content: String,
) -> Result<WriteMarkdownResult, String> {
    let root = state.active_root()?;
    let res = workspace::write_markdown_file(&root, &rel_path, &content)?;
    if let Ok(mut cache) = state.echo_cache.lock() {
        cache.record_write(&res.rel_path, res.sha256.clone());
    }
    Ok(res)
}

pub fn cmd_save_layout(state: &AppState, layout_json: String) -> Result<(), String> {
    let root = state.active_root()?;
    workspace::save_layout(&root, &layout_json)
}

pub fn cmd_load_layout(state: &AppState) -> Result<Option<String>, String> {
    let root = state.active_root()?;
    workspace::load_layout(&root)
}

pub fn cmd_list_presets(state: &AppState) -> Result<Vec<String>, String> {
    let root = state.active_root()?;
    workspace::list_presets(&root)
}

pub fn cmd_load_preset(state: &AppState, name: String) -> Result<String, String> {
    let root = state.active_root()?;
    workspace::load_preset(&root, &name)
}

pub fn cmd_pty_spawn_with_cb<F>(
    state: &AppState,
    cols: u16,
    rows: u16,
    on_output: F,
) -> Result<String, String>
where
    F: FnMut(String, String) + Send + 'static,
{
    let root = state.active_root()?;
    state.pty_manager.spawn(&root, cols, rows, on_output)
}

pub fn cmd_pty_write(state: &AppState, session_id: String, data: String) -> Result<(), String> {
    state.pty_manager.write(&session_id, &data)
}

pub fn cmd_pty_resize(
    state: &AppState,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty_manager.resize(&session_id, cols, rows)
}

pub fn cmd_pty_kill(state: &AppState, session_id: String) -> Result<(), String> {
    state.pty_manager.kill(&session_id)
}

pub fn cmd_pi_send_message(
    state: &AppState,
    envelope: AmbientEnvelope,
) -> Result<PiTurnAck, String> {
    let bin_name = configured_pi_bin_name(state);
    let root = state.active_root()?;
    let mut pi = state
        .pi_adapter
        .lock()
        .map_err(|_| "pi_adapter mutex poisoned".to_string())?;
    // Lazy upgrade: configure no longer blocks on this lock, so an adapter created while pi was
    // missing is swapped here, under the lock this turn already holds.
    if pi.mode() == "offline" && sidecar::resolve_pi_binary(&bin_name).is_some() {
        *pi = create_pi_adapter(&bin_name, &state.pi_cancel);
    }
    pi.send_message(&root, &envelope)
}

fn configured_pi_bin_name(state: &AppState) -> String {
    state
        .global_config
        .lock()
        .map(|c| c.sidecar.dpi_backend_bin.clone())
        .unwrap_or_else(|_| "pi".to_string())
}

/// Pi directories for the setup commands, defaulting to `~/.pi/agent` and the hub config dir.
fn state_pi_dirs(state: &AppState) -> Result<PiDirs, String> {
    match &state.pi_dirs {
        Some(dirs) => Ok(dirs.clone()),
        None => Ok(PiDirs {
            agent_dir: sidecar::default_pi_agent_dir()?,
            hub_config_dir: workspace::config_dir()?,
        }),
    }
}

pub fn cmd_pi_get_setup_status(state: &AppState) -> Result<PiSetupStatus, String> {
    let bin_name = configured_pi_bin_name(state);
    let pi_bin = sidecar::resolve_pi_binary(&bin_name);
    let dirs = state_pi_dirs(state)?;
    sidecar::get_pi_setup_status_in(pi_bin.as_deref(), &dirs.agent_dir, &dirs.hub_config_dir)
}

pub fn cmd_pi_check_provider(state: &AppState, provider: String) -> Result<PiAuthCheckResult, String> {
    let bin_name = configured_pi_bin_name(state);
    let pi_bin = sidecar::resolve_pi_binary(&bin_name)
        .ok_or_else(|| format!("Pi CLI binary '{bin_name}' not found in $PATH"))?;
    let dirs = state_pi_dirs(state)?;
    sidecar::check_pi_provider_auth(&pi_bin, &dirs.agent_dir, &provider)
}

pub fn cmd_pi_configure_provider(
    state: &AppState,
    req: PiConfigureProviderRequest,
) -> Result<PiSetupStatus, String> {
    let bin_name = configured_pi_bin_name(state);
    let pi_bin = sidecar::resolve_pi_binary(&bin_name);
    let dirs = state_pi_dirs(state)?;
    // Never takes the adapter lock: a running turn holds it for up to 180 s. The offline adapter
    // is upgraded lazily by `cmd_pi_send_message` instead.
    sidecar::configure_pi_provider_in(
        pi_bin.as_deref(),
        &dirs.agent_dir,
        &dirs.hub_config_dir,
        &req,
    )
}

pub fn cmd_pi_connect_provider(
    state: &AppState,
    req: PiConnectProviderRequest,
) -> Result<PiConnectResult, String> {
    let bin_name = configured_pi_bin_name(state);
    let pi_bin = sidecar::resolve_pi_binary(&bin_name);
    let dirs = state_pi_dirs(state)?;
    sidecar::connect_pi_provider_in(
        pi_bin.as_deref(),
        &dirs.agent_dir,
        &dirs.hub_config_dir,
        &req,
    )
}

pub fn cmd_pi_list_models(state: &AppState) -> Result<PiModelCatalog, String> {
    let bin_name = configured_pi_bin_name(state);
    let pi_bin = sidecar::resolve_pi_binary(&bin_name);
    let dirs = state_pi_dirs(state)?;
    Ok(sidecar::list_pi_models_in(
        pi_bin.as_deref(),
        &dirs.agent_dir,
        Duration::from_secs(10),
    ))
}

pub fn cmd_pi_logout_provider(state: &AppState, provider: String) -> Result<PiSetupStatus, String> {
    let bin_name = configured_pi_bin_name(state);
    let pi_bin = sidecar::resolve_pi_binary(&bin_name);
    let dirs = state_pi_dirs(state)?;
    sidecar::logout_pi_provider_in(
        pi_bin.as_deref(),
        &dirs.agent_dir,
        &dirs.hub_config_dir,
        &provider,
    )
}

pub fn cmd_save_capture(
    state: &AppState,
    filename: String,
    bytes_base64: String,
) -> Result<CaptureSaved, String> {
    let root = state.active_root()?;
    let quota = state
        .global_config
        .lock()
        .map(|c| c.general.capture_quota_bytes)
        .unwrap_or(workspace::DEFAULT_CAPTURE_QUOTA_BYTES);
    workspace::save_capture(&root, &filename, &bytes_base64, quota)
}

pub fn cmd_list_lenses(state: &AppState) -> Result<Vec<LensInfo>, String> {
    let root = state.active_root()?;
    list_lenses(&root)
}

pub fn cmd_read_lens_html(state: &AppState, lens_id: String) -> Result<String, String> {
    let root = state.active_root()?;
    read_lens_html(&root, &lens_id)
}

pub fn cmd_publish_lens(
    state: &AppState,
    lens_id: String,
    title: String,
    html_content: String,
) -> Result<LensInfo, String> {
    let root = state.active_root()?;
    publish_lens(&root, &lens_id, &title, &html_content)
}

pub fn cmd_list_loop_workflows(state: &AppState) -> Result<Vec<LoopWorkflowInfo>, String> {
    let root = state.active_root()?;
    state.tchelvis.list_workflows(&root)
}

pub fn cmd_check_loop(
    state: &AppState,
    workflow: String,
    use_overrides: Option<Vec<String>>,
) -> Result<LoopCheckResult, String> {
    let root = state.active_root()?;
    state
        .tchelvis
        .check_loop(&root, &workflow, &use_overrides.unwrap_or_default())
}

pub fn cmd_list_loop_runs(state: &AppState) -> Result<Vec<LoopRunState>, String> {
    let root = state.active_root()?;
    let mut cache = state
        .loop_state_cache
        .lock()
        .map_err(|_| "loop_state_cache poisoned".to_string())?;
    list_loop_runs(&root, &mut cache)
}

pub fn cmd_read_loop_report(state: &AppState, run_id: String) -> Result<String, String> {
    let root = state.active_root()?;
    read_loop_report(&root, &run_id)
}

pub fn cmd_dispatch_loop(
    state: &AppState,
    workflow: String,
    title: String,
    spec_markdown: String,
    options: Option<DispatchLoopOptions>,
) -> Result<LoopRunState, String> {
    let root = state.active_root()?;
    state.tchelvis.dispatch_loop(
        &root,
        &workflow,
        &title,
        &spec_markdown,
        &options.unwrap_or_default(),
    )
}

pub fn cmd_stop_loop(state: &AppState, run_id: String) -> Result<(), String> {
    let root = state.active_root()?;
    state.tchelvis.stop_loop(&root, &run_id)
}

pub fn cmd_preview_start(
    state: &AppState,
    mode: String,
    worktree_path: Option<String>,
    hub_rect: Option<HubWindowRect>,
) -> Result<PreviewStatus, String> {
    if mode != "main" && mode != "staging" {
        return Err(format!("unsupported preview mode: {mode}"));
    }
    if mode == "staging" && worktree_path.is_none() {
        return Err("staging preview requires a worktree path".to_string());
    }

    let root = state.active_root()?;
    let game_dir = state.game_dir();
    let (timeout_ms, width, height) = state
        .global_config
        .lock()
        .map(|c| {
            (
                c.preview.healthcheck_timeout_ms,
                c.compositor.preview_width,
                c.compositor.preview_height,
            )
        })
        .unwrap_or((10_000, 1280, 720));

    let wt_path = worktree_path.as_deref().map(Path::new);
    let base = wt_path.unwrap_or(&root);
    let project_dir = base.join(&game_dir);
    if !project_dir.exists() {
        return Err(format!(
            "game directory does not exist: {}",
            project_dir.display()
        ));
    }

    // Same tree means the existing preview wins (no second process on double F5), unless the
    // previous process has already exited. Capture the generation before the import below, so a
    // Cancel pressed meanwhile aborts the start instead of spawning behind the user's back.
    let start_generation = {
        let mut pm = state
            .preview_manager
            .lock()
            .map_err(|_| "preview_manager mutex poisoned".to_string())?;
        if pm.is_active_for(&mode, worktree_path.as_deref()) {
            let (status, retired) = preview_status_and_retired(state, &mut pm);
            drop(pm);
            preview::join_log_readers(retired);
            return Ok(status);
        }
        pm.start_generation()
    };

    let resolution =
        preview::resolve_preview_engine(state.project_engine().as_deref(), &project_dir)?;

    if resolution.engine == PreviewEngine::Godot {
        if let Some(wt) = wt_path {
            let copied = preview::sync_godot_imported_cache(&root, wt, &game_dir)?;
            if copied {
                if let Some(godot_bin) = sidecar::find_binary_in_path("godot") {
                    let _ = std::process::Command::new(godot_bin)
                        .arg("--headless")
                        .arg("--path")
                        .arg(&project_dir)
                        .arg("--import")
                        .status();
                }
            }
        }
    }

    let (spec, port, godot_rect) = match resolution.engine {
        PreviewEngine::Godot => {
            let rect = preview::godot_window_rect(hub_rect, width, height);
            let args = preview::godot_args(&project_dir, rect, hub_rect.is_some());
            (
                preview::LaunchSpec {
                    engine: PreviewEngine::Godot,
                    project_dir: project_dir.clone(),
                    args,
                },
                None,
                Some(rect),
            )
        }
        PreviewEngine::Web => {
            let port = preview::allocate_free_port()?;
            (
                preview::LaunchSpec {
                    engine: PreviewEngine::Web,
                    project_dir: project_dir.clone(),
                    args: preview::web_args(port),
                },
                Some(port),
                None,
            )
        }
    };

    let placement = godot_rect.and_then(|_| {
        preview::placement_warning(
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            state.compositor.backend_name(),
        )
    });
    let warning = join_optional_warnings(resolution.warning, placement);

    let mut pm = state
        .preview_manager
        .lock()
        .map_err(|_| "preview_manager mutex poisoned".to_string())?;
    // A concurrent start may have won the race while the lock was released.
    if pm.is_active_for(&mode, worktree_path.as_deref()) {
        let (status, retired) = preview_status_and_retired(state, &mut pm);
        drop(pm);
        preview::join_log_readers(retired);
        return Ok(status);
    }
    // Cancel during the import/engine probe: no process may start now.
    if pm.start_generation() != start_generation {
        return Err(preview::START_CANCELLED.to_string());
    }
    // Replacing another tree is intentional, so use the generation after `stop`.
    pm.stop();
    let generation = pm.start_generation();
    let pid = pm.begin(
        state.preview_launcher.as_ref(),
        spec,
        &mode,
        worktree_path.as_deref(),
        port,
        warning,
        generation,
    )?;

    if let Some(rect) = godot_rect {
        let (status, retired) = preview_status_and_retired(state, &mut pm);
        drop(pm);
        preview::join_log_readers(retired);
        let _ = state
            .compositor
            .float_and_center_pid(pid, rect.width, rect.height);
        return Ok(status);
    }

    let Some(port) = port else {
        let (status, retired) = preview_status_and_retired(state, &mut pm);
        drop(pm);
        preview::join_log_readers(retired);
        return Ok(status);
    };

    let retired = pm.take_retired();
    // The healthcheck can take seconds; drop the lock so Stop/Cancel and polling stay responsive.
    drop(pm);
    preview::join_log_readers(retired);
    match state
        .preview_launcher
        .wait_ready(port, Duration::from_millis(timeout_ms))
    {
        Ok(()) => {
            let mut pm = state
                .preview_manager
                .lock()
                .map_err(|_| "preview_manager mutex poisoned".to_string())?;
            if !pm.mark_ready(pid) {
                return Err(preview::START_CANCELLED.to_string());
            }
            let (status, retired) = preview_status_and_retired(state, &mut pm);
            drop(pm);
            preview::join_log_readers(retired);
            Ok(status)
        }
        Err(err) => {
            let mut pm = state
                .preview_manager
                .lock()
                .map_err(|_| "preview_manager mutex poisoned".to_string())?;
            pm.fail(pid);
            let retired = pm.take_retired();
            drop(pm);
            preview::join_log_readers(retired);
            Err(err)
        }
    }
}

fn preview_status_and_retired(
    state: &AppState,
    pm: &mut PreviewManager,
) -> (PreviewStatus, Vec<std::thread::JoinHandle<()>>) {
    (
        pm.status(state.compositor.as_ref()),
        pm.take_retired(),
    )
}

pub fn cmd_preview_status(state: &AppState) -> Result<PreviewStatus, String> {
    let (status, retired) = {
        let mut pm = state
            .preview_manager
            .lock()
            .map_err(|_| "preview_manager mutex poisoned".to_string())?;
        preview_status_and_retired(state, &mut pm)
    };
    if retired.is_empty() {
        return Ok(status);
    }
    // A reaped child's log readers may still be draining; join them off-lock and read again so
    // the first idle status already carries the complete tail.
    preview::join_log_readers(retired);
    let mut pm = state
        .preview_manager
        .lock()
        .map_err(|_| "preview_manager mutex poisoned".to_string())?;
    Ok(pm.status(state.compositor.as_ref()))
}

pub fn cmd_preview_focus(state: &AppState) -> Result<(), String> {
    let (pid, retired) = {
        let mut pm = state
            .preview_manager
            .lock()
            .map_err(|_| "preview_manager mutex poisoned".to_string())?;
        let (status, retired) = preview_status_and_retired(state, &mut pm);
        (
            status
                .pid
                .ok_or_else(|| "no active preview running".to_string())?,
            retired,
        )
    };
    preview::join_log_readers(retired);
    state.compositor.focus_pid(pid)
}

/// Joins two optional warnings with `; `, dropping empty ones.
fn join_optional_warnings(first: Option<String>, second: Option<String>) -> Option<String> {
    let parts: Vec<String> = [first, second].into_iter().flatten().collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

pub fn cmd_preview_stop(state: &AppState) -> Result<(), String> {
    let retired = {
        let mut pm = state
            .preview_manager
            .lock()
            .map_err(|_| "preview_manager mutex poisoned".to_string())?;
        pm.stop();
        pm.take_retired()
    };
    preview::join_log_readers(retired);
    Ok(())
}

pub fn cmd_preview_capture(state: &AppState) -> Result<CaptureResult, String> {
    let root = state.active_root()?;
    let pm = state
        .preview_manager
        .lock()
        .map_err(|_| "preview_manager mutex poisoned".to_string())?;
    pm.capture(&root, state.compositor.as_ref())
}

pub fn cmd_git_check_worktree_merge(
    state: &AppState,
    run_id: String,
) -> Result<MergeCheckResult, String> {
    let root = state.active_root()?;
    git_ops::check_worktree_merge(&root, &run_id, &state.default_branch())
}

pub fn cmd_git_merge_worktree(
    state: &AppState,
    run_id: String,
    stash_dirty: bool,
) -> Result<MergeResult, String> {
    let root = state.active_root()?;
    if let Ok(mut pm) = state.preview_manager.lock() {
        pm.stop();
    }
    git_ops::merge_worktree(&root, &run_id, &state.default_branch(), stash_dirty)
}

pub fn cmd_git_list_orphan_worktrees(state: &AppState) -> Result<Vec<String>, String> {
    let root = state.active_root()?;
    git_ops::list_orphan_worktrees(&root)
}

pub fn cmd_git_cleanup_worktree(state: &AppState, run_id: String) -> Result<(), String> {
    let root = state.active_root()?;
    git_ops::cleanup_worktree(&root, &run_id)
}

pub fn cmd_check_for_updates(channel: Option<String>) -> Result<UpdateCheckResult, String> {
    updater::check_for_updates(channel.as_deref())
}

pub fn cmd_cancel_update_check() {
    updater::cancel_update_check();
}

pub fn cmd_apply_update(channel: Option<String>) -> Result<UpdateApplyResult, String> {
    updater::apply_update(channel.as_deref())
}

pub fn cmd_flow_bridge_result(
    state: &AppState,
    job_id: String,
    status: String,
    image_bytes: Option<Vec<u8>>,
    image_base64: Option<String>,
    token: Option<String>,
    error: Option<String>,
) -> Result<FlowGenerationResult, String> {
    state.flow_bridge.resolve_job(
        FlowBridgeCallbackPayload {
            job_id,
            token,
            status,
            image_base64,
            image_bytes,
            mime_type: None,
            error,
        },
        false,
    )
}

pub async fn cmd_dispatch_flow_generation<D: flow_bridge::FlowBrowserDriver>(
    state: &AppState,
    driver: &D,
    prompt: String,
    save_path: String,
    aspect_ratio: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<FlowGenerationResult, String> {
    let root = state.active_root()?;
    let img_cfg = state
        .global_config
        .lock()
        .map(|g| g.image_generation.clone())
        .unwrap_or_default();
    flow_bridge::dispatch_flow_generation_with_driver(
        Arc::clone(&state.flow_bridge),
        driver,
        &root,
        &img_cfg,
        prompt,
        save_path,
        aspect_ratio,
        timeout_secs,
    )
    .await
}

pub fn cmd_browser_navigate<D: browser_panel::BrowserChildDriver>(
    state: &AppState,
    driver: &D,
    url: String,
    bounds: Option<BrowserBounds>,
) -> Result<BrowserPanelState, String> {
    state.browser_panel.navigate(driver, &url, bounds)
}

pub fn cmd_browser_sync_bounds<D: browser_panel::BrowserChildDriver>(
    state: &AppState,
    driver: &D,
    bounds: BrowserBounds,
) -> Result<BrowserPanelState, String> {
    state.browser_panel.sync_bounds(driver, bounds)
}

pub fn cmd_browser_set_visible<D: browser_panel::BrowserChildDriver>(
    state: &AppState,
    driver: &D,
    visible: bool,
) -> Result<BrowserPanelState, String> {
    state.browser_panel.set_visible(driver, visible)
}

pub fn cmd_browser_go_back<D: browser_panel::BrowserChildDriver>(
    state: &AppState,
    driver: &D,
) -> Result<BrowserPanelState, String> {
    state.browser_panel.go_back(driver)
}

pub fn cmd_browser_go_forward<D: browser_panel::BrowserChildDriver>(
    state: &AppState,
    driver: &D,
) -> Result<BrowserPanelState, String> {
    state.browser_panel.go_forward(driver)
}

pub fn cmd_browser_reload<D: browser_panel::BrowserChildDriver>(
    state: &AppState,
    driver: &D,
) -> Result<BrowserPanelState, String> {
    state.browser_panel.reload(driver)
}

pub fn cmd_browser_close<D: browser_panel::BrowserChildDriver>(
    state: &AppState,
    driver: &D,
) -> Result<BrowserPanelState, String> {
    state.browser_panel.close(driver)
}

pub fn cmd_browser_get_state(state: &AppState) -> Result<BrowserPanelState, String> {
    state.browser_panel.get_state()
}

pub fn cmd_browser_capture_snapshot<D: browser_panel::BrowserChildDriver>(
    state: &AppState,
    driver: &D,
    bounds: Option<BrowserBounds>,
) -> Result<BrowserSnapshotResult, String> {
    state.browser_panel.capture_snapshot(driver, bounds)
}

#[cfg(feature = "desktop")]
mod desktop_ipc {
    use super::*;
    use tauri::{Emitter, Manager, State};
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_fs::FsExt;

    #[tauri::command]
    pub fn open_workspace(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        path: String,
    ) -> Result<WorkspaceInfo, String> {
        let info = cmd_open_workspace(&state, path)?;
        let root = PathBuf::from(&info.root_path);
        let _ = app.fs_scope().allow_directory(&root, true);
        let _ = app.asset_protocol_scope().allow_directory(&root, true);

        let root_for_emit = root.clone();
        let app_handle = app.clone();
        let watcher = WorkspaceWatcher::start(root, Arc::clone(&state.echo_cache), move |paths| {
            let mut loops_updated = false;
            for rel_path in paths {
                if rel_path.starts_with(".loops/") {
                    loops_updated = true;
                }
                let kind = if root_for_emit.join(&rel_path).exists() {
                    "modify"
                } else {
                    "remove"
                };
                let _ = app_handle.emit(
                    "fs://changed",
                    serde_json::json!({
                        "rel_path": rel_path,
                        "kind": kind,
                    }),
                );
            }
            if loops_updated {
                let _ = app_handle.emit("loops://updated", ());
            }
        })?;
        if let Ok(mut w) = state.watcher.lock() {
            *w = Some(watcher);
        }
        Ok(info)
    }

    #[tauri::command]
    pub fn list_recent_workspaces() -> Result<Vec<RecentWorkspace>, String> {
        cmd_list_recent_workspaces()
    }

    #[tauri::command]
    pub fn get_workspace_tree(state: State<'_, AppState>) -> Result<Vec<FileTreeNode>, String> {
        cmd_get_workspace_tree(&state)
    }

    #[tauri::command]
    pub fn read_markdown_file(
        state: State<'_, AppState>,
        rel_path: String,
    ) -> Result<MarkdownFilePayload, String> {
        cmd_read_markdown_file(&state, rel_path)
    }

    #[tauri::command]
    pub fn read_binary_file(
        state: State<'_, AppState>,
        rel_path: String,
    ) -> Result<String, String> {
        cmd_read_binary_file(&state, rel_path)
    }

    #[tauri::command]
    pub fn write_markdown_file(
        state: State<'_, AppState>,
        rel_path: String,
        content: String,
    ) -> Result<WriteMarkdownResult, String> {
        cmd_write_markdown_file(&state, rel_path, content)
    }

    #[tauri::command]
    pub fn save_layout(state: State<'_, AppState>, layout_json: String) -> Result<(), String> {
        cmd_save_layout(&state, layout_json)
    }

    #[tauri::command]
    pub fn load_layout(state: State<'_, AppState>) -> Result<Option<String>, String> {
        cmd_load_layout(&state)
    }

    #[tauri::command]
    pub fn list_presets(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        cmd_list_presets(&state)
    }

    #[tauri::command]
    pub fn load_preset(state: State<'_, AppState>, name: String) -> Result<String, String> {
        cmd_load_preset(&state, name)
    }

    #[tauri::command]
    pub fn pty_spawn(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        cmd_pty_spawn_with_cb(&state, cols, rows, move |session_id, data| {
            let _ = app.emit(
                "pty://output",
                serde_json::json!({ "session_id": session_id, "data": data }),
            );
        })
    }

    #[tauri::command]
    pub fn pty_write(
        state: State<'_, AppState>,
        session_id: String,
        data: String,
    ) -> Result<(), String> {
        cmd_pty_write(&state, session_id, data)
    }

    #[tauri::command]
    pub fn pty_resize(
        state: State<'_, AppState>,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        cmd_pty_resize(&state, session_id, cols, rows)
    }

    #[tauri::command]
    pub fn pty_kill(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
        cmd_pty_kill(&state, session_id)
    }

    /// Runs blocking work on Tauri's blocking pool. Synchronous `#[tauri::command]`s execute inline
    /// on the IPC (main) thread, so slow pi calls there would freeze the whole window.
    pub(crate) async fn on_worker<T, F>(f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, String> + Send + 'static,
    {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .map_err(|e| format!("background task failed: {e}"))?
    }

    #[tauri::command]
    pub async fn pi_send_message(
        app: tauri::AppHandle,
        envelope: AmbientEnvelope,
    ) -> Result<PiTurnAck, String> {
        on_worker(move || cmd_pi_send_message(&app.state::<AppState>(), envelope)).await
    }

    #[tauri::command]
    pub async fn pi_get_setup_status(app: tauri::AppHandle) -> Result<PiSetupStatus, String> {
        on_worker(move || cmd_pi_get_setup_status(&app.state::<AppState>())).await
    }

    #[tauri::command]
    pub async fn pi_list_models(app: tauri::AppHandle) -> Result<PiModelCatalog, String> {
        on_worker(move || cmd_pi_list_models(&app.state::<AppState>())).await
    }

    #[tauri::command]
    pub async fn pi_check_provider(
        app: tauri::AppHandle,
        provider: String,
    ) -> Result<PiAuthCheckResult, String> {
        on_worker(move || cmd_pi_check_provider(&app.state::<AppState>(), provider)).await
    }

    #[tauri::command]
    pub async fn pi_configure_provider(
        app: tauri::AppHandle,
        req: PiConfigureProviderRequest,
    ) -> Result<PiSetupStatus, String> {
        on_worker(move || cmd_pi_configure_provider(&app.state::<AppState>(), req)).await
    }

    #[tauri::command]
    pub async fn pi_connect_provider(
        app: tauri::AppHandle,
        req: PiConnectProviderRequest,
    ) -> Result<PiConnectResult, String> {
        on_worker(move || cmd_pi_connect_provider(&app.state::<AppState>(), req)).await
    }

    #[tauri::command]
    pub async fn pi_logout_provider(
        app: tauri::AppHandle,
        provider: String,
    ) -> Result<PiSetupStatus, String> {
        on_worker(move || cmd_pi_logout_provider(&app.state::<AppState>(), provider)).await
    }

    #[tauri::command]
    pub fn save_capture(
        state: State<'_, AppState>,
        filename: String,
        bytes_base64: String,
    ) -> Result<CaptureSaved, String> {
        cmd_save_capture(&state, filename, bytes_base64)
    }

    #[tauri::command]
    pub fn list_lenses(state: State<'_, AppState>) -> Result<Vec<LensInfo>, String> {
        cmd_list_lenses(&state)
    }

    #[tauri::command]
    pub fn read_lens_html(state: State<'_, AppState>, lens_id: String) -> Result<String, String> {
        cmd_read_lens_html(&state, lens_id)
    }

    #[tauri::command]
    pub fn publish_lens(
        state: State<'_, AppState>,
        lens_id: String,
        title: String,
        html_content: String,
    ) -> Result<LensInfo, String> {
        cmd_publish_lens(&state, lens_id, title, html_content)
    }

    #[tauri::command]
    pub fn list_loop_workflows(state: State<'_, AppState>) -> Result<Vec<LoopWorkflowInfo>, String> {
        cmd_list_loop_workflows(&state)
    }

    #[tauri::command]
    pub fn check_loop(
        state: State<'_, AppState>,
        workflow: String,
        use_overrides: Option<Vec<String>>,
    ) -> Result<LoopCheckResult, String> {
        cmd_check_loop(&state, workflow, use_overrides)
    }

    #[tauri::command]
    pub fn list_loop_runs(state: State<'_, AppState>) -> Result<Vec<LoopRunState>, String> {
        cmd_list_loop_runs(&state)
    }

    #[tauri::command]
    pub fn read_loop_report(state: State<'_, AppState>, run_id: String) -> Result<String, String> {
        cmd_read_loop_report(&state, run_id)
    }

    #[tauri::command]
    pub fn dispatch_loop(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        workflow: String,
        title: String,
        spec_markdown: String,
        options: Option<DispatchLoopOptions>,
    ) -> Result<LoopRunState, String> {
        let res = cmd_dispatch_loop(&state, workflow, title, spec_markdown, options)?;
        let _ = app.emit("loops://updated", ());
        Ok(res)
    }

    #[tauri::command]
    pub fn stop_loop(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        run_id: String,
    ) -> Result<(), String> {
        cmd_stop_loop(&state, run_id)?;
        let _ = app.emit("loops://updated", ());
        Ok(())
    }

    #[tauri::command]
    pub async fn preview_start(
        app: tauri::AppHandle,
        mode: String,
        worktree_path: Option<String>,
        hub_rect: Option<HubWindowRect>,
    ) -> Result<PreviewStatus, String> {
        on_worker(move || {
            cmd_preview_start(&app.state::<AppState>(), mode, worktree_path, hub_rect)
        })
        .await
    }

    #[tauri::command]
    pub async fn preview_status(app: tauri::AppHandle) -> Result<PreviewStatus, String> {
        on_worker(move || cmd_preview_status(&app.state::<AppState>())).await
    }

    #[tauri::command]
    pub async fn preview_stop(app: tauri::AppHandle) -> Result<(), String> {
        on_worker(move || cmd_preview_stop(&app.state::<AppState>())).await
    }

    #[tauri::command]
    pub fn preview_focus(state: State<'_, AppState>) -> Result<(), String> {
        cmd_preview_focus(&state)
    }

    #[tauri::command]
    pub fn preview_capture(state: State<'_, AppState>) -> Result<CaptureResult, String> {
        cmd_preview_capture(&state)
    }

    #[tauri::command]
    pub fn git_check_worktree_merge(
        state: State<'_, AppState>,
        run_id: String,
    ) -> Result<MergeCheckResult, String> {
        cmd_git_check_worktree_merge(&state, run_id)
    }

    #[tauri::command]
    pub fn git_merge_worktree(
        state: State<'_, AppState>,
        run_id: String,
        stash_dirty: bool,
    ) -> Result<MergeResult, String> {
        cmd_git_merge_worktree(&state, run_id, stash_dirty)
    }

    #[tauri::command]
    pub fn git_list_orphan_worktrees(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        cmd_git_list_orphan_worktrees(&state)
    }

    #[tauri::command]
    pub fn git_cleanup_worktree(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
        cmd_git_cleanup_worktree(&state, run_id)
    }

    #[tauri::command]
    pub async fn pick_workspace_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
        tokio::task::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("Selecionar Pasta do Projeto")
                .blocking_pick_folder()
                .map(|p| p.to_string())
        })
        .await
        .map_err(|e| format!("Falha ao abrir seletor de pastas: {e}"))
    }

    #[tauri::command]
    pub async fn check_for_updates(channel: Option<String>) -> Result<UpdateCheckResult, String> {
        tokio::task::spawn_blocking(move || cmd_check_for_updates(channel))
            .await
            .map_err(|e| format!("Falha ao verificar atualizações: {e}"))?
    }

    #[tauri::command]
    pub fn cancel_update_check() {
        cmd_cancel_update_check();
    }

    #[tauri::command]
    pub async fn apply_update(channel: Option<String>) -> Result<UpdateApplyResult, String> {
        tokio::task::spawn_blocking(move || cmd_apply_update(channel))
            .await
            .map_err(|e| format!("Falha ao aplicar atualização: {e}"))?
    }

    #[tauri::command]
    pub fn restart_app(app: tauri::AppHandle, state: State<'_, AppState>) {
        state.pty_manager.kill_all();
        if let Ok(mut pm) = state.preview_manager.lock() {
            pm.stop();
        }
        state.shutdown_pi();
        if let Ok(mut w) = state.watcher.lock() {
            *w = None;
        }
        if let Ok(guard) = state.workspace_root.lock() {
            if let Some(root) = guard.as_ref() {
                workspace::release_workspace_lock(root);
            }
        }
        app.restart();
    }

    #[tauri::command]
    pub async fn dispatch_flow_generation(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        prompt: String,
        save_path: String,
        aspect_ratio: Option<String>,
        timeout_secs: Option<u64>,
    ) -> Result<FlowGenerationResult, String> {
        let driver = flow_bridge::desktop_driver::TauriWebviewFlowDriver { app: app.clone() };
        let res = cmd_dispatch_flow_generation(
            &state,
            &driver,
            prompt,
            save_path,
            aspect_ratio,
            timeout_secs,
        )
        .await?;
        let _ = app.emit(
            "fs://changed",
            serde_json::json!({
                "rel_path": res.saved_path,
                "kind": "create",
                "sha256": res.sha256,
            }),
        );
        let _ = app.emit("flow://status", &res);
        Ok(res)
    }

    #[tauri::command]
    pub fn flow_bridge_result(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        job_id: String,
        status: String,
        image_bytes: Option<Vec<u8>>,
        image_base64: Option<String>,
        token: Option<String>,
        error: Option<String>,
    ) -> Result<FlowGenerationResult, String> {
        let res = cmd_flow_bridge_result(
            &state,
            job_id,
            status,
            image_bytes,
            image_base64,
            token,
            error,
        )?;
        let _ = app.emit(
            "fs://changed",
            serde_json::json!({
                "rel_path": res.saved_path,
                "kind": "create",
                "sha256": res.sha256,
            }),
        );
        let _ = app.emit("flow://status", &res);
        Ok(res)
    }

    #[tauri::command]
    pub fn open_flow_browser(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
    ) -> Result<String, String> {
        let global_img = state
            .global_config
            .lock()
            .map(|g| g.image_generation.clone())
            .unwrap_or_default();
        let cfg = match state.active_root() {
            Ok(root) => flow_bridge::resolve_image_generation_config(&root, &global_img),
            Err(_) => global_img,
        };
        let profile_dir = flow_bridge::resolve_webview_profile_dir(&cfg)?;
        flow_bridge::desktop_driver::open_or_focus_flow_window(
            &app,
            &cfg.flow_url,
            &profile_dir,
            Some(Arc::clone(&state.flow_bridge)),
        )?;
        Ok(cfg.flow_url)
    }

    #[tauri::command]
    pub fn browser_navigate(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        url: String,
        bounds: Option<BrowserBounds>,
    ) -> Result<BrowserPanelState, String> {
        let driver = browser_panel::desktop_driver::TauriChildWebviewDriver {
            app: app.clone(),
            manager: Arc::clone(&state.browser_panel),
        };
        let res = cmd_browser_navigate(&state, &driver, url, bounds)?;
        let _ = app.emit("browser://state", &res);
        Ok(res)
    }

    #[tauri::command]
    pub fn browser_sync_bounds(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        bounds: BrowserBounds,
    ) -> Result<BrowserPanelState, String> {
        let driver = browser_panel::desktop_driver::TauriChildWebviewDriver {
            app: app.clone(),
            manager: Arc::clone(&state.browser_panel),
        };
        let res = cmd_browser_sync_bounds(&state, &driver, bounds)?;
        let _ = app.emit("browser://state", &res);
        Ok(res)
    }

    #[tauri::command]
    pub fn browser_set_visible(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        visible: bool,
    ) -> Result<BrowserPanelState, String> {
        let driver = browser_panel::desktop_driver::TauriChildWebviewDriver {
            app: app.clone(),
            manager: Arc::clone(&state.browser_panel),
        };
        let res = cmd_browser_set_visible(&state, &driver, visible)?;
        let _ = app.emit("browser://state", &res);
        Ok(res)
    }

    #[tauri::command]
    pub fn browser_go_back(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
    ) -> Result<BrowserPanelState, String> {
        let driver = browser_panel::desktop_driver::TauriChildWebviewDriver {
            app: app.clone(),
            manager: Arc::clone(&state.browser_panel),
        };
        let res = cmd_browser_go_back(&state, &driver)?;
        let _ = app.emit("browser://state", &res);
        Ok(res)
    }

    #[tauri::command]
    pub fn browser_go_forward(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
    ) -> Result<BrowserPanelState, String> {
        let driver = browser_panel::desktop_driver::TauriChildWebviewDriver {
            app: app.clone(),
            manager: Arc::clone(&state.browser_panel),
        };
        let res = cmd_browser_go_forward(&state, &driver)?;
        let _ = app.emit("browser://state", &res);
        Ok(res)
    }

    #[tauri::command]
    pub fn browser_reload(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
    ) -> Result<BrowserPanelState, String> {
        let driver = browser_panel::desktop_driver::TauriChildWebviewDriver {
            app: app.clone(),
            manager: Arc::clone(&state.browser_panel),
        };
        let res = cmd_browser_reload(&state, &driver)?;
        let _ = app.emit("browser://state", &res);
        Ok(res)
    }

    #[tauri::command]
    pub fn browser_close(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
    ) -> Result<BrowserPanelState, String> {
        let driver = browser_panel::desktop_driver::TauriChildWebviewDriver {
            app: app.clone(),
            manager: Arc::clone(&state.browser_panel),
        };
        let res = cmd_browser_close(&state, &driver)?;
        let _ = app.emit("browser://state", &res);
        Ok(res)
    }

    #[tauri::command]
    pub fn browser_get_state(state: State<'_, AppState>) -> Result<BrowserPanelState, String> {
        cmd_browser_get_state(&state)
    }

    #[tauri::command]
    pub fn browser_capture_snapshot(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        bounds: Option<BrowserBounds>,
    ) -> Result<BrowserSnapshotResult, String> {
        let driver = browser_panel::desktop_driver::TauriChildWebviewDriver {
            app: app.clone(),
            manager: Arc::clone(&state.browser_panel),
        };
        let res = cmd_browser_capture_snapshot(&state, &driver, bounds)?;
        if let Ok(st) = cmd_browser_get_state(&state) {
            let _ = app.emit("browser://state", &st);
        }
        Ok(res)
    }

    pub fn run_desktop(global_config: GlobalConfig) {
        tauri::Builder::default()
            .plugin(tauri_plugin_fs::init())
            .plugin(tauri_plugin_dialog::init())
            .manage(AppState::new(global_config))
            .invoke_handler(tauri::generate_handler![
                open_workspace,
                list_recent_workspaces,
                get_workspace_tree,
                read_markdown_file,
                read_binary_file,
                write_markdown_file,
                save_layout,
                load_layout,
                list_presets,
                load_preset,
                pty_spawn,
                pty_write,
                pty_resize,
                pty_kill,
                pi_send_message,
                pi_get_setup_status,
                pi_list_models,
                pi_check_provider,
                pi_configure_provider,
                pi_connect_provider,
                pi_logout_provider,
                save_capture,
                list_lenses,
                read_lens_html,
                publish_lens,
                list_loop_workflows,
                check_loop,
                list_loop_runs,
                read_loop_report,
                dispatch_loop,
                stop_loop,
                preview_start,
                preview_status,
                preview_stop,
                preview_focus,
                preview_capture,
                git_check_worktree_merge,
                git_merge_worktree,
                git_list_orphan_worktrees,
                git_cleanup_worktree,
                pick_workspace_directory,
                check_for_updates,
                cancel_update_check,
                apply_update,
                restart_app,
                dispatch_flow_generation,
                flow_bridge_result,
                open_flow_browser,
                browser_navigate,
                browser_sync_bounds,
                browser_set_visible,
                browser_go_back,
                browser_go_forward,
                browser_reload,
                browser_close,
                browser_get_state,
                browser_capture_snapshot,
            ])
            .run(tauri::generate_context!())
            .expect("error while running Game Dev Hub");
    }
}

#[cfg(all(test, feature = "desktop"))]
mod desktop_ipc_tests {
    use super::desktop_ipc::on_worker;

    #[test]
    fn on_worker_runs_off_the_calling_thread_and_returns_its_result() {
        let caller = std::thread::current().id();
        let (worker, value) = tauri::async_runtime::block_on(on_worker(move || {
            Ok::<_, String>((std::thread::current().id(), 42))
        }))
        .unwrap();
        assert_ne!(worker, caller);
        assert_eq!(value, 42);

        let err = tauri::async_runtime::block_on(on_worker(|| Err::<(), _>("boom".to_string())));
        assert_eq!(err.unwrap_err(), "boom");
    }
}

#[cfg(feature = "desktop")]
pub use desktop_ipc::run_desktop;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ActiveContext;
    use tempfile::TempDir;

    #[test]
    fn open_workspace_does_not_wait_behind_a_running_pi_turn() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;

        let dir = TempDir::new().unwrap();
        let ws = dir.path().join("ws");
        let pi_agent_dir = dir.path().join("pi-agent");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&pi_agent_dir).unwrap();
        let started = dir.path().join("started");
        let fake_pi = dir.path().join("pi");
        std::fs::write(
            &fake_pi,
            format!("#!/usr/bin/env bash\ntouch '{}'\nexec sleep 30\n", started.display()),
        )
        .unwrap();
        std::fs::set_permissions(&fake_pi, std::fs::Permissions::from_mode(0o755)).unwrap();

        let state = AppState::new(GlobalConfig::default());
        cmd_open_workspace(&state, ws.display().to_string()).unwrap();
        *state.pi_adapter.lock().unwrap() = Box::new(
            sidecar::ProcessPiAdapter::with_agent_dir(fake_pi, pi_agent_dir)
                .with_cancel_token(state.pi_cancel.clone()),
        );

        std::thread::scope(|scope| {
            let turn = scope.spawn(|| {
                cmd_pi_send_message(
                    &state,
                    AmbientEnvelope {
                        user_message: "long turn".to_string(),
                        active_context: ActiveContext {
                            focused_panel: "chat".to_string(),
                            open_tabs: vec![],
                            dirty_files: vec![],
                            latest_loop: None,
                        },
                        one_shot_attachments: vec![],
                    },
                )
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            while !started.exists() {
                assert!(Instant::now() < deadline, "fake pi never started");
                std::thread::sleep(Duration::from_millis(10));
            }

            let switching = Instant::now();
            cmd_open_workspace(&state, ws.display().to_string()).unwrap();
            assert!(
                switching.elapsed() < Duration::from_secs(5),
                "open_workspace waited {:?} behind the running turn",
                switching.elapsed()
            );
            assert!(turn.join().unwrap().unwrap_err().contains("cancel"));
        });
    }

    #[test]
    fn configure_does_not_wait_behind_a_running_turn() {
        use std::sync::mpsc;
        use std::time::Instant;

        let dir = TempDir::new().unwrap();
        let pi_agent_dir = dir.path().join("pi-agent");
        let hub_config_dir = dir.path().join("hub-cfg");
        std::fs::create_dir_all(&pi_agent_dir).unwrap();
        std::fs::create_dir_all(&hub_config_dir).unwrap();

        let mut state = AppState::new(GlobalConfig::default());
        state.pi_dirs = Some(sidecar::PiDirs {
            agent_dir: pi_agent_dir,
            hub_config_dir,
        });
        let state = &state;

        std::thread::scope(|scope| {
            let (locked_tx, locked_rx) = mpsc::channel::<()>();
            let (release_tx, release_rx) = mpsc::channel::<()>();
            let holder = scope.spawn(move || {
                let _guard = state.pi_adapter.lock().unwrap();
                let _ = locked_tx.send(());
                let _ = release_rx.recv();
            });
            locked_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("the fake turn never took the adapter lock");

            let (result_tx, result_rx) = mpsc::channel();
            let configuring = scope.spawn(move || {
                let req = PiConfigureProviderRequest {
                    provider: "opencode-go".to_string(),
                    ..Default::default()
                };
                let _ = result_tx.send(cmd_pi_configure_provider(state, req));
            });

            let started = Instant::now();
            let result = result_rx.recv_timeout(Duration::from_secs(1));
            let waited = started.elapsed();
            // Always release the fake turn, even when configure is still stuck behind it.
            release_tx.send(()).unwrap();
            holder.join().unwrap();
            configuring.join().unwrap();

            let status = result
                .unwrap_or_else(|_| {
                    panic!("configure waited {waited:?} behind the running turn's adapter lock")
                })
                .unwrap();
            assert_eq!(status.active_provider.as_deref(), Some("opencode-go"));
        });
    }

    #[test]
    fn send_upgrades_offline_adapter_lazily() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let ws = dir.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let fake_pi = dir.path().join("pi");
        std::fs::write(
            &fake_pi,
            concat!(
                "#!/usr/bin/env bash\n",
                "echo '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",",
                "\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}'\n",
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake_pi, std::fs::Permissions::from_mode(0o755)).unwrap();

        let config = GlobalConfig {
            sidecar: types::SidecarConfig {
                dpi_backend_bin: fake_pi.display().to_string(),
                tchelvis_bin: "__nonexistent_tchelvis__".to_string(),
            },
            ..GlobalConfig::default()
        };
        let state = AppState::new(config);
        // Set the root directly: `cmd_open_workspace` would also record this temp path in the
        // user's real `~/.config/game-hub` recents, which this test does not need.
        *state.workspace_root.lock().unwrap() = Some(ws);
        *state.pi_adapter.lock().unwrap() = Box::new(sidecar::OfflinePiAdapter);
        assert_eq!(state.pi_adapter.lock().unwrap().mode(), "offline");

        cmd_pi_send_message(
            &state,
            AmbientEnvelope {
                user_message: "hi".to_string(),
                active_context: ActiveContext {
                    focused_panel: "chat".to_string(),
                    open_tabs: vec![],
                    dirty_files: vec![],
                    latest_loop: None,
                },
                one_shot_attachments: vec![],
            },
        )
        .unwrap();

        assert_ne!(state.pi_adapter.lock().unwrap().mode(), "offline");
    }

    #[test]
    fn connect_command_uses_injected_dirs() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let pi_agent_dir = dir.path().join("pi-agent");
        let hub_config_dir = dir.path().join("hub-cfg");
        let agent_dir_log = dir.path().join("agent-dir.log");
        std::fs::create_dir_all(&pi_agent_dir).unwrap();
        std::fs::create_dir_all(&hub_config_dir).unwrap();

        let fake_pi = dir.path().join("pi");
        std::fs::write(
            &fake_pi,
            format!(
                "#!/usr/bin/env bash\nprintf '%s' \"$PI_CODING_AGENT_DIR\" > '{}'\n\
                 echo '{{\"status\":\"ready\",\"provider\":\"opencode-go\",\"authType\":\"api_key\"}}'\n",
                agent_dir_log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake_pi, std::fs::Permissions::from_mode(0o755)).unwrap();

        let config = GlobalConfig {
            sidecar: types::SidecarConfig {
                dpi_backend_bin: fake_pi.display().to_string(),
                tchelvis_bin: "__nonexistent_tchelvis__".to_string(),
            },
            ..GlobalConfig::default()
        };
        let mut state = AppState::new(config);
        state.pi_dirs = Some(sidecar::PiDirs {
            agent_dir: pi_agent_dir.clone(),
            hub_config_dir,
        });

        let result = cmd_pi_connect_provider(
            &state,
            PiConnectProviderRequest {
                provider: "opencode-go".to_string(),
                api_key: "sk-test-connect-key".to_string(),
            },
        )
        .unwrap();

        let auth: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(pi_agent_dir.join("auth.json")).unwrap())
                .unwrap();
        assert_eq!(auth["opencode-go"]["key"], "sk-test-connect-key");
        assert_eq!(
            std::fs::read_to_string(&agent_dir_log).unwrap(),
            pi_agent_dir.display().to_string(),
            "pi auth check must receive the injected agent dir"
        );
        assert_eq!(result.check.as_ref().unwrap().status, "ready");
        assert_eq!(result.check_error, None);
        assert!(result
            .status
            .configured_providers
            .contains(&"opencode-go".to_string()));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("sk-test-connect-key"));
    }

    #[test]
    fn end_to_end_ipc_flow_without_desktop_feature() {
        let dir = TempDir::new().unwrap();
        let state = AppState::new(GlobalConfig::default());

        let info = cmd_open_workspace(&state, dir.path().to_string_lossy().to_string()).unwrap();
        assert!(info.is_uninitialized);

        let write_res =
            cmd_write_markdown_file(&state, "gdd/01-visao-geral.md".into(), "# Game\n".into())
                .unwrap();
        let read_res =
            cmd_read_markdown_file(&state, "gdd/01-visao-geral.md".into()).unwrap();
        assert_eq!(write_res.sha256, read_res.sha256);

        let tree = cmd_get_workspace_tree(&state).unwrap();
        assert!(!tree.is_empty());

        let ack = cmd_pi_send_message(
            &state,
            AmbientEnvelope {
                user_message: "Brainstorm core loop".into(),
                active_context: ActiveContext {
                    focused_panel: "markdown".into(),
                    open_tabs: vec!["gdd/01-visao-geral.md".into()],
                    dirty_files: vec![],
                    latest_loop: None,
                },
                one_shot_attachments: vec![],
            },
        )
        .unwrap();
        assert!(!ack.turn_id.is_empty());

        let lens = cmd_publish_lens(
            &state,
            "stats-table".into(),
            "Stats Table".into(),
            "<table></table>".into(),
        )
        .unwrap();
        assert_eq!(lens.lens_id, "stats-table");
        assert_eq!(cmd_list_lenses(&state).unwrap().len(), 1);

        let workflows = cmd_list_loop_workflows(&state).unwrap();
        assert!(workflows.iter().any(|w| w.name == "fast-worker-reviewer"));

        let mut custom_state = AppState::new(GlobalConfig {
            sidecar: types::SidecarConfig {
                dpi_backend_bin: "__nonexistent_dpi__".to_string(),
                tchelvis_bin: "__nonexistent_tchelvis__".to_string(),
            },
            ..GlobalConfig::default()
        });
        let _ = cmd_open_workspace(&custom_state, dir.path().to_string_lossy().to_string()).unwrap();
        let check = cmd_check_loop(&custom_state, "fast-worker-reviewer".into(), None).unwrap();
        assert!(!check.tchelvis_available);

        let dispatched = cmd_dispatch_loop(
            &custom_state,
            "fast-worker-reviewer".into(),
            "Dash".into(),
            "Implement dash".into(),
            Some(DispatchLoopOptions {
                use_overrides: vec!["implement=pi:opencode-go/deepseek-v4.1-flash".into()],
                max_cycles: Some(2),
                from_head: true,
            }),
        )
        .unwrap();
        assert_eq!(dispatched.status, "queued-offline");
        let runs = cmd_list_loop_runs(&custom_state).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, dispatched.run_id);
        assert!(cmd_stop_loop(&custom_state, dispatched.run_id).is_err());
        let _ = &mut custom_state;
    }
}

#[cfg(test)]
mod preview_command_tests {
    use super::*;
    use crate::preview::{LaunchSpec, PreviewLauncher};
    use crate::types::{PreviewEngine, ProjectConfig};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    enum FakeWait {
        Ok,
        Err(String),
        Blocked(mpsc::Receiver<Result<(), String>>),
    }

    #[derive(Default)]
    struct FakeLauncherInner {
        specs: Mutex<Vec<LaunchSpec>>,
        wait: Mutex<Option<FakeWait>>,
        command: Mutex<String>,
        ready_marker: Mutex<Option<PathBuf>>,
    }

    #[derive(Clone, Default)]
    struct FakeLauncher {
        inner: Arc<FakeLauncherInner>,
    }

    impl FakeLauncher {
        fn new(wait: FakeWait) -> Self {
            let launcher = Self::default();
            *launcher.inner.wait.lock().unwrap() = Some(wait);
            launcher
        }

        fn with_command(self, command: &str) -> Self {
            *self.inner.command.lock().unwrap() = command.to_string();
            self
        }

        /// Makes `wait_ready` return only after the child created `marker`, so log assertions
        /// do not race the process startup.
        fn with_ready_marker(self, marker: &Path) -> Self {
            *self.inner.ready_marker.lock().unwrap() = Some(marker.to_path_buf());
            self
        }

        fn specs(&self) -> Vec<LaunchSpec> {
            self.inner.specs.lock().unwrap().clone()
        }
    }

    impl PreviewLauncher for FakeLauncher {
        fn spawn(&self, spec: &LaunchSpec) -> Result<Child, String> {
            self.inner.specs.lock().unwrap().push(spec.clone());
            let command = {
                let configured = self.inner.command.lock().unwrap().clone();
                if configured.is_empty() {
                    "sleep 30".to_string()
                } else {
                    configured
                }
            };
            let mut cmd = Command::new("sh");
            cmd.arg("-c")
                .arg(command)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            cmd.spawn().map_err(|e| format!("fake spawn failed: {e}"))
        }

        fn wait_ready(&self, _port: u16, _timeout: Duration) -> Result<(), String> {
            let wait = self
                .inner
                .wait
                .lock()
                .unwrap()
                .take()
                .unwrap_or(FakeWait::Ok);
            if let Some(marker) = self.inner.ready_marker.lock().unwrap().clone() {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !marker.exists() {
                    assert!(Instant::now() < deadline, "fake child never signalled readiness");
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            match wait {
                FakeWait::Ok => Ok(()),
                FakeWait::Err(err) => Err(err),
                FakeWait::Blocked(rx) => {
                    rx.recv().unwrap_or_else(|_| Err("cancelled".to_string()))
                }
            }
        }
    }

    /// Builds an `AppState` pointing at a temp workspace whose `game/` matches `engine`.
    fn preview_workspace(engine: &str) -> (TempDir, AppState) {
        let dir = TempDir::new().unwrap();
        let game = dir.path().join("ws/game");
        std::fs::create_dir_all(&game).unwrap();
        if engine == "godot" {
            std::fs::write(game.join("project.godot"), "").unwrap();
        } else {
            std::fs::write(
                game.join("package.json"),
                r#"{"scripts":{"dev":"vite"}}"#,
            )
            .unwrap();
        }

        let state = AppState::new(GlobalConfig::default());
        *state.workspace_root.lock().unwrap() = Some(dir.path().join("ws"));
        *state.project_config.lock().unwrap() = Some(ProjectConfig {
            schema_version: 1,
            engine: engine.to_string(),
            game_dir: "game".to_string(),
            default_branch: "main".to_string(),
        });
        (dir, state)
    }

    fn attach_launcher(state: &mut AppState, launcher: &FakeLauncher) {
        state.preview_launcher = Box::new(launcher.clone());
    }

    fn wait_for_spawn(launcher: &FakeLauncher) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while launcher.specs().is_empty() {
            assert!(Instant::now() < deadline, "preview never spawned");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn preview_start_main_dispatches_on_resolved_engine() {
        let (_dir, mut state) = preview_workspace("godot");
        let launcher = FakeLauncher::new(FakeWait::Ok);
        attach_launcher(&mut state, &launcher);

        let status = cmd_preview_start(&state, "main".into(), None, None).unwrap();
        let specs = launcher.specs();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].engine, PreviewEngine::Godot);
        assert_eq!(
            specs[0].project_dir,
            state.active_root().unwrap().join("game")
        );
        assert_eq!(status.mode, "main");
        assert!(status.running);

        let (_dir, mut state) = preview_workspace("web");
        let launcher = FakeLauncher::new(FakeWait::Ok);
        attach_launcher(&mut state, &launcher);

        let status = cmd_preview_start(&state, "main".into(), None, None).unwrap();
        let specs = launcher.specs();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].engine, PreviewEngine::Web);
        assert!(specs[0].args.iter().any(|a| a == "--strictPort"));
        assert_eq!(status.mode, "main");
        assert!(status.running);
    }

    #[test]
    fn godot_start_passes_rect_args() {
        let (_dir, mut state) = preview_workspace("godot");
        let launcher = FakeLauncher::new(FakeWait::Ok);
        attach_launcher(&mut state, &launcher);

        let hub = HubWindowRect {
            x: 100,
            y: 50,
            width: 1920,
            height: 1080,
        };
        let status = cmd_preview_start(&state, "main".into(), None, Some(hub)).unwrap();

        let specs = launcher.specs();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].engine, PreviewEngine::Godot);
        assert!(
            specs[0]
                .args
                .windows(2)
                .any(|pair| pair == ["--position", "420,230"]),
            "args: {:?}",
            specs[0].args
        );
        assert!(specs[0].args.iter().any(|arg| arg == "--always-on-top"));
        assert_eq!(status.engine, Some(PreviewEngine::Godot));
        assert!(status.running);
    }

    #[test]
    fn second_start_same_tree_keeps_pid() {
        let (_dir, mut state) = preview_workspace("godot");
        let launcher = FakeLauncher::new(FakeWait::Ok);
        attach_launcher(&mut state, &launcher);

        let first = cmd_preview_start(&state, "main".into(), None, None).unwrap();
        let second = cmd_preview_start(&state, "main".into(), None, None).unwrap();

        assert_eq!(launcher.specs().len(), 1);
        assert_eq!(first.pid, second.pid);
        assert!(second.running);
    }

    #[test]
    fn exited_preview_is_reaped_and_f5_starts_a_new_process() {
        let (_dir, mut state) = preview_workspace("godot");
        let launcher = FakeLauncher::new(FakeWait::Ok).with_command("echo bye; exit 0");
        attach_launcher(&mut state, &launcher);

        let _first = cmd_preview_start(&state, "main".into(), None, None).unwrap();

        // The user closed the game window: the next status poll must notice and go idle.
        let deadline = Instant::now() + Duration::from_secs(5);
        let idle = loop {
            let status = cmd_preview_status(&state).unwrap();
            if status.mode == "idle" {
                break status;
            }
            assert!(Instant::now() < deadline, "exited preview was never reaped");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(!idle.running);
        assert!(idle.logs.iter().any(|line| line == "bye"), "logs: {:?}", idle.logs);

        // F5 (or a direct start) now spawns again instead of returning the stale status.
        let _second = cmd_preview_start(&state, "main".into(), None, None).unwrap();
        assert_eq!(launcher.specs().len(), 2);
    }

    #[test]
    fn unknown_mode_is_rejected() {
        let (_dir, mut state) = preview_workspace("web");
        let launcher = FakeLauncher::new(FakeWait::Ok);
        attach_launcher(&mut state, &launcher);

        let err = cmd_preview_start(&state, "web".into(), None, None).unwrap_err();
        assert_eq!(err, "unsupported preview mode: web");
        assert!(launcher.specs().is_empty());
    }

    #[test]
    fn start_returns_cancelled_when_stopped_during_healthcheck() {
        let (_dir, mut state) = preview_workspace("web");
        let (tx, rx) = mpsc::channel();
        let launcher = FakeLauncher::new(FakeWait::Blocked(rx));
        attach_launcher(&mut state, &launcher);

        std::thread::scope(|scope| {
            let start = scope.spawn(|| cmd_preview_start(&state, "main".into(), None, None));
            wait_for_spawn(&launcher);

            let stopped = Instant::now();
            cmd_preview_stop(&state).unwrap();
            assert!(
                stopped.elapsed() < Duration::from_secs(1),
                "preview_stop waited on the healthcheck"
            );

            tx.send(Ok(())).unwrap();
            let err = start.join().unwrap().unwrap_err();
            assert_eq!(err, "preview start cancelled");
        });

        let status = cmd_preview_status(&state).unwrap();
        assert!(!status.running);
        assert_eq!(status.mode, "idle");
    }

    #[test]
    fn failed_healthcheck_keeps_logs() {
        let (dir, mut state) = preview_workspace("web");
        let marker = dir.path().join("preview-ready");
        let command = format!("echo boot; touch '{}'; sleep 30", marker.display());
        let launcher = FakeLauncher::new(FakeWait::Err("healthcheck timed out".into()))
            .with_command(&command)
            .with_ready_marker(&marker);
        attach_launcher(&mut state, &launcher);

        let err = cmd_preview_start(&state, "main".into(), None, None).unwrap_err();
        assert!(err.contains("healthcheck timed out"), "err: {err}");

        let status = cmd_preview_status(&state).unwrap();
        assert!(!status.running);
        assert_eq!(status.mode, "idle");
        assert!(
            status.logs.iter().any(|line| line == "boot"),
            "logs: {:?}",
            status.logs
        );
    }

    #[test]
    fn status_while_starting_has_pid_not_running() {
        let (_dir, mut state) = preview_workspace("web");
        let (tx, rx) = mpsc::channel();
        let launcher = FakeLauncher::new(FakeWait::Blocked(rx));
        attach_launcher(&mut state, &launcher);

        std::thread::scope(|scope| {
            let start = scope.spawn(|| cmd_preview_start(&state, "main".into(), None, None));

            let deadline = Instant::now() + Duration::from_secs(5);
            let starting = loop {
                let status = cmd_preview_status(&state).unwrap();
                if status.pid.is_some() {
                    break status;
                }
                assert!(Instant::now() < deadline, "preview never started");
                std::thread::sleep(Duration::from_millis(5));
            };
            assert!(!starting.running);
            assert_eq!(starting.engine, Some(PreviewEngine::Web));

            tx.send(Ok(())).unwrap();
            let finished = start.join().unwrap().unwrap();
            assert!(finished.running);
        });
    }
}
