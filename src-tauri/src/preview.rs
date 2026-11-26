use crate::compositor::CompositorAdapter;
use crate::sidecar::find_binary_in_path;
use crate::types::{CaptureResult, HubWindowRect, PreviewEngine, PreviewStatus};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_LOG_LINES: usize = 200;
/// How many log lines a `PreviewStatus` carries on the wire.
const STATUS_LOG_LINES: usize = 50;
/// Returned (and logged by the UI) when a start is cancelled while it was still setting up.
pub const START_CANCELLED: &str = "preview start cancelled";
/// Upper bound for detaching log-reader threads after the manager lock is released.
const LOG_JOIN_TIMEOUT: Duration = Duration::from_millis(250);

/// The engine a preview runs on, plus any config/file conflict worth surfacing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineResolution {
    pub engine: PreviewEngine,
    pub warning: Option<String>,
}

/// Resolves the preview engine: `.hub/project.json` wins when it names a known engine,
/// otherwise the project files decide. A disagreement is reported as a warning.
pub fn resolve_preview_engine(
    config_engine: Option<&str>,
    game_dir: &Path,
) -> Result<EngineResolution, String> {
    let configured = config_engine
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .and_then(parse_engine);
    let detected = detect_engine(game_dir);

    match (configured, detected) {
        (Some(engine), detected) => {
            let warning = match detected {
                Some(found) if found != engine => Some(format!(
                    "preview engine conflict: .hub/project.json selects '{}' but {} was detected; using '{}'",
                    engine_name(engine),
                    engine_source(found),
                    engine_name(engine),
                )),
                _ => None,
            };
            Ok(EngineResolution { engine, warning })
        }
        (None, Some(engine)) => Ok(EngineResolution {
            engine,
            warning: None,
        }),
        (None, None) => Err(
            "could not detect a preview engine: neither project.godot nor package.json with a `dev` script was found"
                .to_string(),
        ),
    }
}

fn parse_engine(raw: &str) -> Option<PreviewEngine> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "godot" => Some(PreviewEngine::Godot),
        "web" => Some(PreviewEngine::Web),
        _ => None,
    }
}

fn engine_name(engine: PreviewEngine) -> &'static str {
    match engine {
        PreviewEngine::Godot => "godot",
        PreviewEngine::Web => "web",
    }
}

fn engine_source(engine: PreviewEngine) -> &'static str {
    match engine {
        PreviewEngine::Godot => "project.godot",
        PreviewEngine::Web => "package.json scripts.dev",
    }
}

fn detect_engine(game_dir: &Path) -> Option<PreviewEngine> {
    if game_dir.join("project.godot").is_file() {
        return Some(PreviewEngine::Godot);
    }
    package_has_dev_script(game_dir).then_some(PreviewEngine::Web)
}

fn package_has_dev_script(game_dir: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(game_dir.join("package.json")) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    json.get("scripts")
        .and_then(|scripts| scripts.get("dev"))
        .and_then(|dev| dev.as_str())
        .is_some_and(|dev| !dev.trim().is_empty())
}

/// Everything a `PreviewLauncher` needs to start one preview process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub engine: PreviewEngine,
    pub project_dir: PathBuf,
    pub args: Vec<String>,
}

/// Process spawning for previews, injected so dispatch is testable without real Godot/npm.
pub trait PreviewLauncher: Send + Sync {
    fn spawn(&self, spec: &LaunchSpec) -> Result<Child, String>;
    fn wait_ready(&self, port: u16, timeout: Duration) -> Result<(), String>;
}

/// Production launcher: npm for Vite, the `godot` binary for Godot projects.
pub struct SystemPreviewLauncher;

impl PreviewLauncher for SystemPreviewLauncher {
    fn spawn(&self, spec: &LaunchSpec) -> Result<Child, String> {
        let (program, label) = match spec.engine {
            PreviewEngine::Godot => (
                find_binary_in_path("godot").ok_or("`godot` not found in $PATH")?,
                "Godot preview",
            ),
            PreviewEngine::Web => (
                find_binary_in_path("npm").ok_or("`npm` not found in $PATH")?,
                "Vite preview",
            ),
        };

        let mut cmd = Command::new(program);
        cmd.current_dir(&spec.project_dir)
            .args(&spec.args)
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

        cmd.spawn()
            .map_err(|e| format!("failed to spawn {label}: {e}"))
    }

    fn wait_ready(&self, port: u16, timeout: Duration) -> Result<(), String> {
        wait_for_http_ok(port, timeout)
    }
}

/// Args for `npm run dev -- --port <port> --strictPort`.
pub fn web_args(port: u16) -> Vec<String> {
    vec![
        "run".to_string(),
        "dev".to_string(),
        "--".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--strictPort".to_string(),
    ]
}

/// Physical rectangle where a Godot preview window should be placed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Centres the configured preview size over the Hub window, scaled down to fit with a 5 % margin.
pub fn godot_window_rect(hub: Option<HubWindowRect>, preview_w: u32, preview_h: u32) -> WindowRect {
    let preview_w = preview_w.max(1);
    let preview_h = preview_h.max(1);
    let Some(hub) = hub else {
        return WindowRect {
            x: 0,
            y: 0,
            width: preview_w,
            height: preview_h,
        };
    };

    let available_w = (hub.width as f64 * 0.9).max(1.0);
    let available_h = (hub.height as f64 * 0.9).max(1.0);
    let scale = 1.0_f64
        .min(available_w / preview_w as f64)
        .min(available_h / preview_h as f64);
    let width = ((preview_w as f64 * scale).round() as u32).max(1);
    let height = ((preview_h as f64 * scale).round() as u32).max(1);

    WindowRect {
        x: hub.x + ((hub.width as i64 - width as i64) / 2) as i32,
        y: hub.y + ((hub.height as i64 - height as i64) / 2) as i32,
        width,
        height,
    }
}

/// Godot 4 CLI args for a windowed, always-on-top preview at `rect`.
pub fn godot_args(project_dir: &Path, rect: WindowRect, with_position: bool) -> Vec<String> {
    let mut args = vec![
        "--path".to_string(),
        project_dir.display().to_string(),
        "--windowed".to_string(),
        "--resolution".to_string(),
        format!("{}x{}", rect.width, rect.height),
    ];
    if with_position {
        args.push("--position".to_string());
        args.push(format!("{},{}", rect.x, rect.y));
    }
    args.push("--always-on-top".to_string());
    args
}

/// Warns when native Wayland may ignore the requested window position.
pub fn placement_warning(session_type: Option<&str>, compositor_backend: &str) -> Option<String> {
    if compositor_backend == "hyprland" {
        return None;
    }
    let session = session_type?.trim().to_ascii_lowercase();
    if session == "wayland" {
        Some(
            "Godot window position may be ignored under native Wayland; use Focus game to raise it"
                .to_string(),
        )
    } else {
        None
    }
}

/// Allocates a free ephemeral TCP port on `127.0.0.1:0`.
pub fn allocate_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to bind ephemeral port: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("failed to read local_addr: {e}"))?;
    Ok(addr.port())
}

/// Polls `GET http://127.0.0.1:<port>/` until a `200` HTTP response is received or `timeout` expires.
pub fn wait_for_http_ok(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let addr = format!("127.0.0.1:{port}");
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect_timeout(
            &addr.parse().map_err(|e| format!("invalid addr: {e}"))?,
            Duration::from_millis(200),
        ) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let req = format!("GET / HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut buf = [0u8; 256];
                if let Ok(n) = stream.read(&mut buf) {
                    let resp = String::from_utf8_lossy(&buf[..n]);
                    if resp.starts_with("HTTP/1.1 200") || resp.starts_with("HTTP/1.0 200") {
                        return Ok(());
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "preview HTTP healthcheck timed out on http://{addr}/ after {}ms",
        timeout.as_millis()
    ))
}

/// Syncs `<root>/<game_dir>/.godot/imported` into `<worktree>/<game_dir>/.godot/imported`
/// using `cp --reflink=auto -r` when `<worktree>/<game_dir>/.godot` does not yet exist.
pub fn sync_godot_imported_cache(
    workspace_root: &Path,
    worktree_root: &Path,
    game_dir: &str,
) -> Result<bool, String> {
    let dst_godot = worktree_root.join(game_dir).join(".godot");
    if dst_godot.exists() {
        return Ok(false);
    }
    let src_imported = workspace_root.join(game_dir).join(".godot/imported");
    if !src_imported.exists() {
        return Ok(false);
    }
    fs::create_dir_all(&dst_godot)
        .map_err(|e| format!("failed to create {}: {e}", dst_godot.display()))?;
    let status = Command::new("cp")
        .args(["--reflink=auto", "-r"])
        .arg(&src_imported)
        .arg(&dst_godot)
        .status()
        .map_err(|e| format!("failed to run cp --reflink=auto: {e}"))?;
    if !status.success() {
        return Err(format!("cp --reflink=auto exited with {status}"));
    }
    Ok(true)
}

struct ActivePreview {
    engine: PreviewEngine,
    /// Which tree the preview runs: `"main"` or `"staging"` (never the engine).
    tree: String,
    worktree_path: Option<String>,
    /// `false` while a web preview is still passing its healthcheck.
    ready: bool,
    warning: Option<String>,
    url: Option<String>,
    child: Child,
    log_tail: Arc<Mutex<VecDeque<String>>>,
    log_handles: Vec<thread::JoinHandle<()>>,
}

/// Manages the lifecycle of the local Vite or Godot preview process.
#[derive(Default)]
pub struct PreviewManager {
    active: Option<ActivePreview>,
    /// Bumped by `stop` so a start that was cancelled while importing aborts before spawning.
    start_generation: u64,
    /// Log tail of the last failed start, surfaced while idle so the UI can show it.
    pub last_failure_logs: Vec<String>,
    /// Shared tail of the last failed start; reader threads may still append while it is read.
    last_failure_tail: Option<Arc<Mutex<VecDeque<String>>>>,
    /// Log-reader threads of retired previews, joined only after the manager lock is dropped.
    retired_handles: Vec<thread::JoinHandle<()>>,
}

impl PreviewManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reaps an exited child first, so a dead preview never counts as running.
    pub fn status(&mut self, compositor: &dyn CompositorAdapter) -> PreviewStatus {
        self.reap_exited();
        let compositor_available = compositor.backend_name() != "degraded";
        let compositor_reason = compositor.degraded_reason();
        match &self.active {
            Some(p) => {
                let running = p.ready;
                PreviewStatus {
                    running,
                    mode: p.tree.clone(),
                    engine: Some(p.engine),
                    url: p.url.clone(),
                    pid: Some(p.child.id()),
                    worktree_path: p.worktree_path.clone(),
                    compositor_available,
                    can_capture: running && compositor_available,
                    degraded_reason: join_reasons(
                        p.warning.as_deref(),
                        compositor_reason.as_deref(),
                    ),
                    logs: log_tail_lines(&p.log_tail, STATUS_LOG_LINES),
                }
            }
            None => {
                let logs = if let Some(tail) = self.last_failure_tail.clone() {
                    let logs = log_tail_lines(&tail, STATUS_LOG_LINES);
                    // Keep the public snapshot current once the reader threads have flushed.
                    self.last_failure_logs = logs.clone();
                    logs
                } else {
                    self.last_failure_logs
                        .iter()
                        .rev()
                        .take(STATUS_LOG_LINES)
                        .rev()
                        .cloned()
                        .collect()
                };
                PreviewStatus {
                    running: false,
                    mode: "idle".to_string(),
                    engine: None,
                    url: None,
                    pid: None,
                    worktree_path: None,
                    compositor_available,
                    can_capture: false,
                    degraded_reason: compositor_reason,
                    logs,
                }
            }
        }
    }

    /// True when a preview for exactly this tree (and worktree path) is alive.
    pub fn is_active_for(&mut self, tree: &str, worktree: Option<&str>) -> bool {
        self.reap_exited();
        self.active.as_ref().is_some_and(|preview| {
            preview.tree == tree && preview.worktree_path.as_deref() == worktree
        })
    }

    pub fn start_generation(&self) -> u64 {
        self.start_generation
    }

    /// Spawns the preview process and records it as the active one. Godot is ready immediately;
    /// web stays not-ready until `mark_ready` after the healthcheck.
    #[allow(clippy::too_many_arguments)]
    pub fn begin(
        &mut self,
        launcher: &dyn PreviewLauncher,
        spec: LaunchSpec,
        tree: &str,
        worktree: Option<&str>,
        port: Option<u16>,
        warning: Option<String>,
        generation: u64,
    ) -> Result<u32, String> {
        if generation != self.start_generation {
            return Err(START_CANCELLED.to_string());
        }
        // A spawn error must not show the previous failure's logs.
        self.last_failure_logs.clear();
        self.last_failure_tail = None;

        let mut child = launcher.spawn(&spec)?;
        let pid = child.id();
        let (log_tail, log_handles) = attach_log_readers(&mut child);
        let ready = spec.engine == PreviewEngine::Godot;
        let url = port.map(|port| format!("http://127.0.0.1:{port}/"));

        self.active = Some(ActivePreview {
            engine: spec.engine,
            tree: tree.to_string(),
            worktree_path: worktree.map(str::to_string),
            ready,
            warning,
            url,
            child,
            log_tail,
            log_handles,
        });
        Ok(pid)
    }

    /// Marks a starting preview as ready. Returns `false` when `pid` was cancelled meanwhile.
    pub fn mark_ready(&mut self, pid: u32) -> bool {
        match self.active.as_mut() {
            Some(preview) if preview.child.id() == pid => {
                preview.ready = true;
                true
            }
            _ => false,
        }
    }

    /// Kills a failed preview and keeps its log tail for the idle error state.
    pub fn fail(&mut self, pid: u32) {
        let Some(mut preview) = self.active.take() else {
            return;
        };
        if preview.child.id() != pid {
            self.active = Some(preview);
            return;
        }
        terminate_process_group(&mut preview.child);
        self.record_failure(preview);
    }

    pub fn stop(&mut self) {
        // Also flags a start that is still importing/healthchecking as cancelled.
        self.start_generation = self.start_generation.wrapping_add(1);
        if let Some(mut active) = self.active.take() {
            terminate_process_group(&mut active.child);
            self.retired_handles.append(&mut active.log_handles);
        }
    }

    /// Takes the handles collected from retired previews; join them without holding the lock.
    pub fn take_retired(&mut self) -> Vec<thread::JoinHandle<()>> {
        std::mem::take(&mut self.retired_handles)
    }

    /// Turns a naturally exited child into the idle state and keeps its logs for the error UI.
    fn reap_exited(&mut self) {
        let exited = matches!(
            self.active.as_mut().map(|p| p.child.try_wait()),
            Some(Ok(Some(_)))
        );
        if !exited {
            return;
        }
        let Some(mut preview) = self.active.take() else {
            return;
        };
        // The leader is gone, but the rest of its process group may still be alive.
        terminate_process_group(&mut preview.child);
        self.record_failure(preview);
    }

    fn record_failure(&mut self, preview: ActivePreview) {
        let ActivePreview {
            log_tail,
            log_handles,
            ..
        } = preview;
        self.last_failure_logs = log_tail_lines(&log_tail, STATUS_LOG_LINES);
        self.last_failure_tail = Some(log_tail);
        self.retired_handles.extend(log_handles);
    }

    pub fn capture(
        &self,
        workspace_root: &Path,
        compositor: &dyn CompositorAdapter,
    ) -> Result<CaptureResult, String> {
        let Some(active) = &self.active else {
            return Err("no active preview running".to_string());
        };
        let log_tail: Vec<String> = active
            .log_tail
            .lock()
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default();

        let captures_dir = workspace_root.join(".hub/captures");
        fs::create_dir_all(&captures_dir)
            .map_err(|e| format!("failed to create .hub/captures: {e}"))?;
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let rel_path = format!(".hub/captures/preview-{ts}.png");
        let abs_path: PathBuf = workspace_root.join(&rel_path);

        match compositor.capture_pid_region(active.child.id(), &abs_path) {
            Ok(()) => Ok(CaptureResult {
                image_path: Some(rel_path),
                log_tail,
                error: None,
            }),
            Err(err) => Ok(CaptureResult {
                image_path: None,
                log_tail,
                error: Some(err),
            }),
        }
    }
}

impl Drop for PreviewManager {
    fn drop(&mut self) {
        self.stop();
    }
}

fn attach_log_readers(
    child: &mut Child,
) -> (Arc<Mutex<VecDeque<String>>>, Vec<thread::JoinHandle<()>>) {
    let buf = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES)));
    let mut handles = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let b = Arc::clone(&buf);
        handles.push(thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                push_log_line(&b, line);
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let b = Arc::clone(&buf);
        handles.push(thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                push_log_line(&b, line);
            }
        }));
    }
    (buf, handles)
}

fn push_log_line(buf: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut q) = buf.lock() {
        if q.len() >= MAX_LOG_LINES {
            q.pop_front();
        }
        q.push_back(line);
    }
}

fn log_tail_lines(buf: &Arc<Mutex<VecDeque<String>>>, limit: usize) -> Vec<String> {
    buf.lock()
        .map(|q| {
            let skip = q.len().saturating_sub(limit);
            q.iter().skip(skip).cloned().collect()
        })
        .unwrap_or_default()
}

/// Joins the optional non-empty degraded reasons with `; `.
fn join_reasons(first: Option<&str>, second: Option<&str>) -> Option<String> {
    let parts: Vec<&str> = [first, second].into_iter().flatten().collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

/// Joins log-reader threads with a bounded wait. Callers must not hold the manager lock.
pub fn join_log_readers(handles: Vec<thread::JoinHandle<()>>) {
    let deadline = Instant::now() + LOG_JOIN_TIMEOUT;
    for handle in handles {
        while !handle.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        if handle.is_finished() {
            let _ = handle.join();
        }
        // Still blocked on a wedged pipe: detach instead of freezing the IPC thread.
    }
}

fn process_group_alive(pgid: libc::pid_t) -> bool {
    if unsafe { libc::killpg(pgid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// SIGTERMs the whole group, then SIGKILLs it even when the leader already exited.
fn terminate_process_group(child: &mut Child) {
    let pid = child.id() as libc::pid_t;
    unsafe {
        libc::killpg(pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_millis(400);
    loop {
        let leader_done = matches!(child.try_wait(), Ok(Some(_)));
        if leader_done && !process_group_alive(pid) {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    // The leader exiting does not mean the group is gone: a child may ignore SIGTERM and
    // keep the log pipes open. SIGKILL the group unconditionally (ESRCH when already gone).
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compositor::DegradedCompositorAdapter;
    use crate::types::{HubWindowRect, PreviewEngine};
    use tempfile::TempDir;

    fn write_file(dir: &Path, rel: &str, contents: &str) {
        fs::write(dir.join(rel), contents).unwrap();
    }

    #[test]
    fn resolve_preview_engine_prefers_config_and_warns_on_conflict() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "project.godot", "");

        let res = resolve_preview_engine(Some("web"), dir.path()).unwrap();
        assert_eq!(res.engine, PreviewEngine::Web);
        let warning = res.warning.expect("conflict must warn");
        assert!(warning.contains("project.godot"), "warning: {warning}");
    }

    #[test]
    fn resolve_preview_engine_falls_back_to_godot_file() {
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "project.godot", "");

        let res = resolve_preview_engine(None, dir.path()).unwrap();
        assert_eq!(res.engine, PreviewEngine::Godot);
        assert_eq!(res.warning, None);
    }

    #[test]
    fn resolve_preview_engine_falls_back_to_web_package() {
        for config_engine in [Some(""), Some("unity")] {
            let dir = TempDir::new().unwrap();
            write_file(
                dir.path(),
                "package.json",
                r#"{"scripts":{"dev":"vite"}}"#,
            );

            let res = resolve_preview_engine(config_engine, dir.path()).unwrap();
            assert_eq!(res.engine, PreviewEngine::Web);
            assert_eq!(res.warning, None);
        }
    }

    #[test]
    fn resolve_preview_engine_rejects_package_without_dev_script() {
        let dir = TempDir::new().unwrap();
        write_file(
            dir.path(),
            "package.json",
            r#"{"scripts":{"build":"vite build"}}"#,
        );

        let err = resolve_preview_engine(None, dir.path()).unwrap_err();
        assert!(err.contains("project.godot"), "err: {err}");
        assert!(err.contains("package.json"), "err: {err}");
    }

    #[test]
    fn resolve_preview_engine_rejects_when_nothing_is_found() {
        let dir = TempDir::new().unwrap();
        let err = resolve_preview_engine(None, dir.path()).unwrap_err();
        assert!(err.contains("project.godot"), "err: {err}");
        assert!(err.contains("package.json"), "err: {err}");
    }

    #[test]
    fn rect_centres_preview_in_large_hub() {
        let hub = HubWindowRect {
            x: 100,
            y: 50,
            width: 1920,
            height: 1080,
        };

        assert_eq!(
            godot_window_rect(Some(hub), 1280, 720),
            WindowRect {
                x: 420,
                y: 230,
                width: 1280,
                height: 720,
            }
        );
    }

    #[test]
    fn rect_scales_down_in_small_hub() {
        let hub = HubWindowRect {
            x: 0,
            y: 0,
            width: 1000,
            height: 700,
        };

        let rect = godot_window_rect(Some(hub), 1280, 720);
        assert_eq!(rect.width, 900);
        assert_eq!(rect.height, 506);
        assert_eq!(rect.x, 50);
        assert_eq!(rect.y, 97);
    }

    #[test]
    fn rect_without_hub_uses_configured_size() {
        assert_eq!(
            godot_window_rect(None, 1280, 720),
            WindowRect {
                x: 0,
                y: 0,
                width: 1280,
                height: 720,
            }
        );
    }

    #[test]
    fn godot_args_order() {
        let dir = Path::new("/tmp/game");
        let rect = WindowRect {
            x: 420,
            y: 230,
            width: 1280,
            height: 720,
        };

        assert_eq!(
            godot_args(dir, rect, true),
            vec![
                "--path",
                "/tmp/game",
                "--windowed",
                "--resolution",
                "1280x720",
                "--position",
                "420,230",
                "--always-on-top",
            ]
        );

        let args = godot_args(dir, rect, false);
        assert!(!args.iter().any(|arg| arg == "--position"));
        assert!(args.iter().any(|arg| arg == "--always-on-top"));
    }

    #[test]
    fn placement_warning_only_on_unmanaged_wayland() {
        let warning = placement_warning(Some("wayland"), "degraded")
            .expect("native Wayland without Hyprland must warn");
        assert!(
            warning.contains("position may be ignored"),
            "warning: {warning}"
        );
        assert_eq!(placement_warning(Some("wayland"), "hyprland"), None);
        assert_eq!(placement_warning(Some("x11"), "degraded"), None);
    }

    fn idle_status() -> PreviewStatus {
        PreviewStatus {
            running: false,
            mode: "idle".to_string(),
            engine: None,
            url: None,
            pid: None,
            worktree_path: None,
            compositor_available: false,
            can_capture: false,
            degraded_reason: None,
            logs: Vec::new(),
        }
    }

    fn running_status() -> PreviewStatus {
        PreviewStatus {
            running: true,
            mode: "main".to_string(),
            engine: Some(PreviewEngine::Godot),
            url: None,
            pid: Some(4321),
            worktree_path: None,
            compositor_available: true,
            can_capture: true,
            degraded_reason: None,
            logs: vec!["boot".to_string()],
        }
    }

    #[test]
    fn preview_status_serializes_exact_keys() {
        let expected = [
            "can_capture",
            "compositor_available",
            "degraded_reason",
            "engine",
            "logs",
            "mode",
            "pid",
            "running",
            "url",
            "worktree_path",
        ];

        for status in [idle_status(), running_status()] {
            let value = serde_json::to_value(&status).unwrap();
            let mut keys: Vec<&str> = value
                .as_object()
                .expect("PreviewStatus serializes to a JSON object")
                .keys()
                .map(|k| k.as_str())
                .collect();
            keys.sort_unstable();
            assert_eq!(keys, expected);
        }

        let value = serde_json::to_value(running_status()).unwrap();
        assert_eq!(value["engine"], serde_json::json!("godot"));
        assert_eq!(value["mode"], serde_json::json!("main"));
        assert!(value["port"].is_null());
    }

    #[test]
    fn idle_status_reports_compositor_and_failure_logs() {
        let compositor = DegradedCompositorAdapter {
            reason: "HYPRLAND_INSTANCE_SIGNATURE not set".to_string(),
        };
        let mut manager = PreviewManager::new();
        let status = manager.status(&compositor);
        assert!(!status.running);
        assert_eq!(status.mode, "idle");
        assert_eq!(status.engine, None);
        assert!(!status.compositor_available);
        assert!(!status.can_capture);
        assert!(status.logs.is_empty());
        assert_eq!(
            status.degraded_reason.as_deref(),
            Some("HYPRLAND_INSTANCE_SIGNATURE not set")
        );

        let mut manager = PreviewManager::new();
        manager.last_failure_logs = vec!["boot".to_string(), "healthcheck timed out".to_string()];
        let status = manager.status(&compositor);
        assert_eq!(status.logs, vec!["boot", "healthcheck timed out"]);

        manager.last_failure_logs = (0..60).map(|i| format!("line {i}")).collect();
        let status = manager.status(&compositor);
        assert_eq!(status.logs.len(), 50);
        assert_eq!(status.logs.first().map(String::as_str), Some("line 10"));
    }

    #[test]
    fn allocate_free_port_and_http_healthcheck_work() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let handle = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });

        wait_for_http_ok(port, Duration::from_secs(2)).unwrap();
        handle.join().unwrap();

        let free_port = allocate_free_port().unwrap();
        assert!(free_port > 0);
    }

    #[test]
    fn sync_godot_imported_cache_copies_when_absent() {
        let root = TempDir::new().unwrap();
        let wt = TempDir::new().unwrap();
        let src_imp = root.path().join("game/.godot/imported");
        fs::create_dir_all(&src_imp).unwrap();
        fs::write(src_imp.join("tex.ctex"), b"ctex").unwrap();
        fs::create_dir_all(wt.path().join("game")).unwrap();

        let copied = sync_godot_imported_cache(root.path(), wt.path(), "game").unwrap();
        assert!(copied);
        assert!(wt.path().join("game/.godot/imported/tex.ctex").exists());

        // Second call is a no-op because .godot already exists
        let copied_again = sync_godot_imported_cache(root.path(), wt.path(), "game").unwrap();
        assert!(!copied_again);
    }

    /// Runs a shell command in its own process group, like the real launcher.
    struct ShellLauncher {
        command: String,
        spawns: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl ShellLauncher {
        fn new(command: &str) -> Self {
            Self {
                command: command.to_string(),
                spawns: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }

        fn spawn_count(&self) -> usize {
            self.spawns.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl PreviewLauncher for ShellLauncher {
        fn spawn(&self, _spec: &LaunchSpec) -> Result<Child, String> {
            self.spawns
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut cmd = Command::new("sh");
            cmd.arg("-c")
                .arg(&self.command)
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
            Ok(())
        }
    }

    struct FailingLauncher;

    impl PreviewLauncher for FailingLauncher {
        fn spawn(&self, _spec: &LaunchSpec) -> Result<Child, String> {
            Err("`godot` not found in $PATH".to_string())
        }

        fn wait_ready(&self, _port: u16, _timeout: Duration) -> Result<(), String> {
            Ok(())
        }
    }

    fn godot_spec() -> LaunchSpec {
        LaunchSpec {
            engine: PreviewEngine::Godot,
            project_dir: PathBuf::from("/tmp/game"),
            args: Vec::new(),
        }
    }

    fn degraded() -> DegradedCompositorAdapter {
        DegradedCompositorAdapter {
            reason: String::new(),
        }
    }

    #[test]
    fn reap_exited_child_moves_its_logs_to_the_idle_status() {
        let mut manager = PreviewManager::new();
        let launcher = ShellLauncher::new("echo bye; exit 0");
        manager
            .begin(
                &launcher,
                godot_spec(),
                "main",
                None,
                None,
                None,
                manager.start_generation(),
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = manager.status(&degraded());
            if status.mode == "idle" {
                break;
            }
            assert!(Instant::now() < deadline, "exited preview was never reaped");
            thread::sleep(Duration::from_millis(10));
        }
        // The command layer joins before returning; the manager exposes the live tail, so joining
        // here makes the final snapshot deterministic.
        join_log_readers(manager.take_retired());
        let status = manager.status(&degraded());

        assert!(!status.running);
        assert_eq!(status.pid, None);
        assert!(
            status.logs.iter().any(|line| line == "bye"),
            "logs: {:?}",
            status.logs
        );
        assert!(!manager.is_active_for("main", None));
    }

    #[test]
    fn begin_clears_the_previous_failure_logs_before_spawning() {
        let mut manager = PreviewManager::new();
        manager.last_failure_logs = vec!["previous failure".to_string()];

        let err = manager
            .begin(
                &FailingLauncher,
                godot_spec(),
                "main",
                None,
                None,
                None,
                manager.start_generation(),
            )
            .unwrap_err();
        assert!(err.contains("godot"), "err: {err}");
        assert!(manager.status(&degraded()).logs.is_empty());
    }

    #[test]
    fn begin_refuses_a_generation_cancelled_while_importing() {
        let mut manager = PreviewManager::new();
        let launcher = ShellLauncher::new("sleep 30");
        let generation = manager.start_generation();
        // Cancel arrives while the Godot import is running, before `begin`.
        manager.stop();

        let err = manager
            .begin(
                &launcher,
                godot_spec(),
                "staging",
                Some("/tmp/wt"),
                None,
                None,
                generation,
            )
            .unwrap_err();
        assert_eq!(err, START_CANCELLED);
        assert_eq!(launcher.spawn_count(), 0);
        assert!(!manager.is_active_for("staging", Some("/tmp/wt")));
    }

    #[test]
    fn terminate_process_group_kills_the_group_after_the_leader_exits() {
        let dir = TempDir::new().unwrap();
        let pid_file = dir.path().join("child.pid");
        let command = format!(
            "trap '' TERM; sleep 30 & echo $! > '{}'; exit 0",
            pid_file.display()
        );
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
        let mut child = cmd.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pid_file.exists() {
            assert!(Instant::now() < deadline, "child never wrote its pid");
            thread::sleep(Duration::from_millis(5));
        }
        assert!(child.wait().unwrap().success());
        let group_child: libc::pid_t = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(group_child, 0) }, 0);

        let started = Instant::now();
        terminate_process_group(&mut child);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "terminate took {:?}",
            started.elapsed()
        );

        let deadline = Instant::now() + Duration::from_secs(5);
        while unsafe { libc::kill(group_child, 0) } == 0 {
            assert!(
                Instant::now() < deadline,
                "group member {group_child} survived SIGKILL"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn fail_does_not_wait_for_a_wedged_log_reader() {
        let launcher = ShellLauncher::new("trap '' TERM; sleep 30 & exit 0");
        let mut manager = PreviewManager::new();
        let pid = manager
            .begin(
                &launcher,
                godot_spec(),
                "main",
                None,
                None,
                None,
                manager.start_generation(),
            )
            .unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        let handle = thread::spawn(move || {
            let started = Instant::now();
            manager.fail(pid);
            let elapsed = started.elapsed();
            let retired = manager.take_retired();
            let _ = tx.send(elapsed);
            join_log_readers(retired);
        });

        let elapsed = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("fail() blocked on a log reader while holding the manager");
        assert!(elapsed < Duration::from_secs(2), "fail took {elapsed:?}");
        handle.join().unwrap();
    }
}
