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
use preview::PreviewManager;
use pty::PtyManager;
use sidecar::{
    create_pi_adapter, list_lenses, publish_lens, read_lens_html, ControlSocket,
    DefaultTchelvisAdapter, PiCancelToken, PiSidecarAdapter, TchelvisAdapter,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use types::{
    AmbientEnvelope, BrowserBounds, BrowserPanelState, BrowserSnapshotResult, CaptureResult,
    CaptureSaved, DispatchLoopOptions, FileTreeNode, FlowBridgeCallbackPayload,
    FlowGenerationResult, GlobalConfig, LensInfo, LoopCheckResult, LoopRunState, LoopWorkflowInfo,
    MarkdownFilePayload, MergeCheckResult, MergeResult, PiAuthCheckResult,
    PiConfigureProviderRequest, PiModelCatalog, PiSetupStatus, PiTurnAck, PreviewStatus, ProjectConfig,
    RecentWorkspace, UpdateApplyResult, UpdateCheckResult, WorkspaceInfo, WriteMarkdownResult,
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
    pub tchelvis: Box<dyn TchelvisAdapter>,
    pub preview_manager: Mutex<PreviewManager>,
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
            tchelvis,
            preview_manager: Mutex::new(PreviewManager::new()),
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
    let root = state.active_root()?;
    let mut pi = state
        .pi_adapter
        .lock()
        .map_err(|_| "pi_adapter mutex poisoned".to_string())?;
    pi.send_message(&root, &envelope)
}

fn configured_pi_bin_name(state: &AppState) -> String {
    state
        .global_config
        .lock()
        .map(|c| c.sidecar.dpi_backend_bin.clone())
        .unwrap_or_else(|_| "pi".to_string())
}

pub fn cmd_pi_get_setup_status(state: &AppState) -> Result<PiSetupStatus, String> {
    let bin_name = configured_pi_bin_name(state);
    sidecar::get_pi_setup_status(&bin_name)
}

pub fn cmd_pi_check_provider(state: &AppState, provider: String) -> Result<PiAuthCheckResult, String> {
    let bin_name = configured_pi_bin_name(state);
    sidecar::check_pi_provider(&bin_name, &provider)
}

pub fn cmd_pi_configure_provider(
    state: &AppState,
    req: PiConfigureProviderRequest,
) -> Result<PiSetupStatus, String> {
    let bin_name = configured_pi_bin_name(state);
    let status = sidecar::configure_pi_provider(&bin_name, &req)?;
    if status.pi_available {
        if let Ok(mut pi) = state.pi_adapter.lock() {
            if pi.mode() == "offline" {
                *pi = create_pi_adapter(&bin_name, &state.pi_cancel);
            }
        }
    }
    Ok(status)
}

pub fn cmd_pi_list_models(state: &AppState) -> Result<PiModelCatalog, String> {
    let bin_name = configured_pi_bin_name(state);
    sidecar::list_pi_models(&bin_name)
}

pub fn cmd_pi_logout_provider(state: &AppState, provider: String) -> Result<PiSetupStatus, String> {
    let bin_name = configured_pi_bin_name(state);
    sidecar::logout_pi_provider(&bin_name, &provider)
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
) -> Result<PreviewStatus, String> {
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
    let mut pm = state
        .preview_manager
        .lock()
        .map_err(|_| "preview_manager mutex poisoned".to_string())?;

    match mode.as_str() {
        "web" | "vite" => pm.start_web(
            &root,
            wt_path,
            &game_dir,
            Duration::from_millis(timeout_ms),
            state.compositor.as_ref(),
        ),
        "godot" | "staging" => pm.start_godot(
            &root,
            wt_path,
            &game_dir,
            width,
            height,
            state.compositor.as_ref(),
        ),
        _ => Err(format!("unsupported preview mode: {mode}")),
    }
}

pub fn cmd_preview_stop(state: &AppState) -> Result<(), String> {
    let mut pm = state
        .preview_manager
        .lock()
        .map_err(|_| "preview_manager mutex poisoned".to_string())?;
    pm.stop();
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
    pub fn preview_start(
        state: State<'_, AppState>,
        mode: String,
        worktree_path: Option<String>,
    ) -> Result<PreviewStatus, String> {
        cmd_preview_start(&state, mode, worktree_path)
    }

    #[tauri::command]
    pub fn preview_stop(state: State<'_, AppState>) -> Result<(), String> {
        cmd_preview_stop(&state)
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
                preview_stop,
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
