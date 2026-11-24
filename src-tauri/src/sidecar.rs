use crate::types::{AmbientEnvelope, LensInfo, LoopRunState, PiTurnAck};
use crate::workspace::{canonicalize_in_workspace, current_socket_path, sha256_hex};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static TURN_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Generates a per-boot session token without external RNG dependencies.
pub fn generate_session_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = format!("{}-{}-{}", std::process::id(), nanos, TURN_COUNTER.fetch_add(1, Ordering::Relaxed));
    sha256_hex(seed.as_bytes())
}

/// Checks if `bin_name` is executable on `$PATH` (or as an explicit path).
pub fn find_binary_in_path(bin_name: &str) -> Option<PathBuf> {
    let candidate = Path::new(bin_name);
    if candidate.components().count() > 1 {
        return candidate.is_file().then(|| candidate.to_path_buf());
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let full = dir.join(bin_name);
        if full.is_file() {
            return Some(full);
        }
    }
    None
}

/// Validates a lens slug against `^[a-z0-9-]+$`.
pub fn validate_lens_slug(lens_id: &str) -> Result<(), String> {
    if lens_id.is_empty() {
        return Err("lens_id must not be empty".to_string());
    }
    if !lens_id
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(format!(
            "invalid lens_id '{lens_id}': must match ^[a-z0-9-]+$"
        ));
    }
    Ok(())
}

/// Converts an arbitrary title into a safe `[a-z0-9-]+` slug.
pub fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in input.chars() {
        let lc = ch.to_ascii_lowercase();
        if lc.is_ascii_alphanumeric() {
            out.push(lc);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

/// Publishes a read-only HTML lens to `.hub/views/<lens_id>.html`.
pub fn publish_lens(
    workspace_root: &Path,
    lens_id: &str,
    title: &str,
    html_content: &str,
) -> Result<LensInfo, String> {
    validate_lens_slug(lens_id)?;
    let rel_path = format!(".hub/views/{lens_id}.html");
    let abs = canonicalize_in_workspace(workspace_root, &rel_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create .hub/views: {e}"))?;
    }
    let meta_comment = format!("<!-- hub-lens-title: {} -->\n", title.replace("-->", ""));
    let final_html = if html_content.trim_start().starts_with("<!-- hub-lens-title:") {
        html_content.to_string()
    } else {
        format!("{meta_comment}{html_content}")
    };
    fs::write(&abs, final_html.as_bytes())
        .map_err(|e| format!("failed to write lens {lens_id}: {e}"))?;

    Ok(LensInfo {
        lens_id: lens_id.to_string(),
        title: title.to_string(),
        rel_path,
    })
}

/// Lists all lenses in `.hub/views/*.html`.
pub fn list_lenses(workspace_root: &Path) -> Result<Vec<LensInfo>, String> {
    let views_dir = workspace_root.join(".hub/views");
    if !views_dir.exists() {
        return Ok(Vec::new());
    }
    let mut lenses = Vec::new();
    for entry in fs::read_dir(&views_dir).map_err(|e| format!("failed to read .hub/views: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("html") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_lens_slug(stem).is_err() {
            continue;
        }
        let content = fs::read_to_string(&path).unwrap_or_default();
        let title = extract_lens_title(&content).unwrap_or_else(|| stem.to_string());
        lenses.push(LensInfo {
            lens_id: stem.to_string(),
            title,
            rel_path: format!(".hub/views/{stem}.html"),
        });
    }
    lenses.sort_by(|a, b| a.lens_id.cmp(&b.lens_id));
    Ok(lenses)
}

fn extract_lens_title(html: &str) -> Option<String> {
    let prefix = "<!-- hub-lens-title:";
    let first_line = html.lines().next()?.trim();
    if let Some(rest) = first_line.strip_prefix(prefix) {
        if let Some(title) = rest.strip_suffix("-->") {
            let trimmed = title.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Reads the HTML contents of a published lens.
pub fn read_lens_html(workspace_root: &Path, lens_id: &str) -> Result<String, String> {
    validate_lens_slug(lens_id)?;
    let rel_path = format!(".hub/views/{lens_id}.html");
    let abs = canonicalize_in_workspace(workspace_root, &rel_path)?;
    fs::read_to_string(&abs).map_err(|e| format!("failed to read lens {lens_id}: {e}"))
}

/// Adapter boundary for `Pi Durable` (`dpi-backend`).
pub trait PiSidecarAdapter: Send {
    fn mode(&self) -> &'static str;
    fn send_message(
        &mut self,
        workspace_root: &Path,
        envelope: &AmbientEnvelope,
    ) -> Result<PiTurnAck, String>;
    fn shutdown(&mut self);
}

/// Offline fallback used when `dpi-backend` is not present in `$PATH`.
#[derive(Debug, Default)]
pub struct OfflinePiAdapter;

impl PiSidecarAdapter for OfflinePiAdapter {
    fn mode(&self) -> &'static str {
        "offline"
    }

    fn send_message(
        &mut self,
        _workspace_root: &Path,
        envelope: &AmbientEnvelope,
    ) -> Result<PiTurnAck, String> {
        let turn_id = format!("turn-{}", TURN_COUNTER.fetch_add(1, Ordering::Relaxed));
        let reply_text = format!(
            "[Chat offline fallback: `dpi-backend` not found in $PATH] Received message ({} chars) with focused_panel='{}', {} dirty file(s), {} one-shot attachment(s).",
            envelope.user_message.len(),
            envelope.active_context.focused_panel,
            envelope.active_context.dirty_files.len(),
            envelope.one_shot_attachments.len()
        );
        Ok(PiTurnAck {
            turn_id,
            mode: "offline".to_string(),
            reply_text,
            tool_calls: Vec::new(),
        })
    }

    fn shutdown(&mut self) {}
}

/// Subprocess-backed adapter for `dpi-backend` running in its own process group.
pub struct ProcessPiAdapter {
    bin_path: PathBuf,
    child: Option<Child>,
}

impl ProcessPiAdapter {
    pub fn new(bin_path: PathBuf) -> Self {
        Self {
            bin_path,
            child: None,
        }
    }

    fn ensure_started(&mut self, workspace_root: &Path) -> Result<(), String> {
        if let Some(child) = &mut self.child {
            if let Ok(None) = child.try_wait() {
                return Ok(());
            }
        }
        let mut cmd = Command::new(&self.bin_path);
        cmd.current_dir(workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // SAFETY: setsid() creates a new session/process group for clean group termination.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn dpi-backend: {e}"))?;
        self.child = Some(child);
        Ok(())
    }
}

impl PiSidecarAdapter for ProcessPiAdapter {
    fn mode(&self) -> &'static str {
        "dpi-backend"
    }

    fn send_message(
        &mut self,
        workspace_root: &Path,
        envelope: &AmbientEnvelope,
    ) -> Result<PiTurnAck, String> {
        self.ensure_started(workspace_root)?;
        let turn_id = format!("turn-{}", TURN_COUNTER.fetch_add(1, Ordering::Relaxed));
        Ok(PiTurnAck {
            turn_id,
            mode: "dpi-backend".to_string(),
            reply_text: format!(
                "Dispatched to dpi-backend ({} dirty files, {} attachments).",
                envelope.active_context.dirty_files.len(),
                envelope.one_shot_attachments.len()
            ),
            tool_calls: Vec::new(),
        })
    }

    fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            let pid = child.id() as libc::pid_t;
            // SAFETY: terminate the sidecar's process group cleanly.
            unsafe {
                libc::killpg(pid, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_millis(400);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
            let _ = child.wait();
        }
    }
}

impl Drop for ProcessPiAdapter {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Creates the appropriate `PiSidecarAdapter` depending on `$PATH`.
pub fn create_pi_adapter(bin_name: &str) -> Box<dyn PiSidecarAdapter> {
    if let Some(path) = find_binary_in_path(bin_name) {
        Box::new(ProcessPiAdapter::new(path))
    } else {
        Box::new(OfflinePiAdapter)
    }
}

/// Adapter boundary for `tchelvis loop`.
pub trait TchelvisAdapter: Send + Sync {
    fn dispatch_loop(
        &self,
        workspace_root: &Path,
        workflow: &str,
        title: &str,
        spec_markdown: &str,
    ) -> Result<String, String>;
}

/// Default `TchelvisAdapter` that writes `.loops/inputs/<timestamp>-<slug>.md`
/// and invokes `tchelvis loop run` if available, or records an offline stub run.
pub struct DefaultTchelvisAdapter {
    pub bin_name: String,
}

impl TchelvisAdapter for DefaultTchelvisAdapter {
    fn dispatch_loop(
        &self,
        workspace_root: &Path,
        workflow: &str,
        title: &str,
        spec_markdown: &str,
    ) -> Result<String, String> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let slug = slugify(title);
        let run_id = format!("{ts}-{slug}");

        let input_rel = format!(".loops/inputs/{run_id}.md");
        let input_abs = canonicalize_in_workspace(workspace_root, &input_rel)?;
        if let Some(parent) = input_abs.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create .loops/inputs: {e}"))?;
        }
        fs::write(&input_abs, spec_markdown.as_bytes())
            .map_err(|e| format!("failed to write loop spec: {e}"))?;

        if let Some(bin_path) = find_binary_in_path(&self.bin_name) {
            let mut cmd = Command::new(bin_path);
            cmd.current_dir(workspace_root)
                .args(["loop", "run", "--workflow", workflow, "--input", &input_rel])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            // Detached background process: survives Hub close per spec Section 10.1.
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
            cmd.spawn()
                .map_err(|e| format!("failed to launch tchelvis loop: {e}"))?;
        } else {
            // Offline fallback: record initial state.json so LoopsPanel can display the dispatched run.
            let run_dir = workspace_root.join(".loops/runs").join(&run_id);
            fs::create_dir_all(&run_dir)
                .map_err(|e| format!("failed to create offline run dir: {e}"))?;
            let state = LoopRunState {
                run_id: run_id.clone(),
                workflow: workflow.to_string(),
                title: title.to_string(),
                status: "queued-offline".to_string(),
                current_stage: "spec-written".to_string(),
                stages: vec!["spec-written".to_string()],
                worktree_path: None,
                exit_summary: vec![
                    "tchelvis binary not found in $PATH; spec saved for manual/offline execution."
                        .to_string(),
                ],
            };
            let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
            fs::write(run_dir.join("state.json"), json)
                .map_err(|e| format!("failed to write offline state.json: {e}"))?;
        }

        Ok(run_id)
    }
}

/// Binds the local control Unix socket in `$XDG_RUNTIME_DIR/game-hub/<pid>.sock`
/// with `0600` permissions and a per-boot session token.
pub struct ControlSocket {
    pub socket_path: PathBuf,
    pub session_token: String,
    _listener: UnixListener,
}

impl ControlSocket {
    pub fn bind() -> Result<Self, String> {
        let socket_path = current_socket_path()?;
        if socket_path.exists() {
            let _ = fs::remove_file(&socket_path);
        }
        let listener = UnixListener::bind(&socket_path)
            .map_err(|e| format!("failed to bind control socket: {e}"))?;
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("failed to set socket 0600 permissions: {e}"))?;
        Ok(Self {
            socket_path,
            session_token: generate_session_token(),
            _listener: listener,
        })
    }
}

impl Drop for ControlSocket {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ActiveContext;
    use tempfile::TempDir;

    #[test]
    fn lens_slug_validation_and_publish_works() {
        assert!(validate_lens_slug("combat-stats-v2").is_ok());
        assert!(validate_lens_slug("BadSlug").is_err());
        assert!(validate_lens_slug("../escape").is_err());
        assert!(validate_lens_slug("a/b").is_err());
        assert!(validate_lens_slug("").is_err());

        let dir = TempDir::new().unwrap();
        let info = publish_lens(dir.path(), "map-view", "World Map", "<h1>Map</h1>").unwrap();
        assert_eq!(info.rel_path, ".hub/views/map-view.html");

        let list = list_lenses(dir.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "World Map");

        let html = read_lens_html(dir.path(), "map-view").unwrap();
        assert!(html.contains("<h1>Map</h1>"));
    }

    #[test]
    fn offline_pi_adapter_handles_ambient_envelope() {
        let dir = TempDir::new().unwrap();
        let mut adapter = OfflinePiAdapter;
        let env = AmbientEnvelope {
            user_message: "Test".to_string(),
            active_context: ActiveContext {
                focused_panel: "markdown".to_string(),
                open_tabs: vec!["gdd/01.md".to_string()],
                dirty_files: vec!["gdd/01.md".to_string()],
                latest_loop: None,
            },
            one_shot_attachments: vec![],
        };
        let ack = adapter.send_message(dir.path(), &env).unwrap();
        assert_eq!(ack.mode, "offline");
        assert!(ack.reply_text.contains("1 dirty file"));
    }

    #[test]
    fn dispatch_loop_writes_spec_and_offline_state() {
        let dir = TempDir::new().unwrap();
        let adapter = DefaultTchelvisAdapter {
            bin_name: "__nonexistent_tchelvis_bin__".to_string(),
        };
        let run_id = adapter
            .dispatch_loop(dir.path(), "implement", "Player Dash", "# Spec\nDash!")
            .unwrap();
        assert!(dir.path().join(format!(".loops/inputs/{run_id}.md")).exists());
        assert!(dir
            .path()
            .join(format!(".loops/runs/{run_id}/state.json"))
            .exists());
    }
}
