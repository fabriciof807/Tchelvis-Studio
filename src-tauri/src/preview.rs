use crate::compositor::CompositorAdapter;
use crate::sidecar::find_binary_in_path;
use crate::types::{CaptureResult, PreviewStatus};
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
    mode: String,
    port: Option<u16>,
    url: Option<String>,
    child: Child,
    log_tail: Arc<Mutex<VecDeque<String>>>,
}

/// Manages the lifecycle of the local Vite or Godot preview process.
pub struct PreviewManager {
    active: Option<ActivePreview>,
}

impl Default for PreviewManager {
    fn default() -> Self {
        Self { active: None }
    }
}

impl PreviewManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self, compositor: &dyn CompositorAdapter) -> PreviewStatus {
        match &self.active {
            Some(p) => PreviewStatus {
                active: true,
                mode: p.mode.clone(),
                port: p.port,
                url: p.url.clone(),
                pid: Some(p.child.id()),
                degraded_reason: compositor.degraded_reason(),
            },
            None => PreviewStatus {
                active: false,
                mode: "idle".to_string(),
                port: None,
                url: None,
                pid: None,
                degraded_reason: compositor.degraded_reason(),
            },
        }
    }

    pub fn start_web(
        &mut self,
        workspace_root: &Path,
        worktree_path: Option<&Path>,
        game_dir: &str,
        timeout: Duration,
        compositor: &dyn CompositorAdapter,
    ) -> Result<PreviewStatus, String> {
        self.stop();
        let base = worktree_path.unwrap_or(workspace_root);
        let project_dir = base.join(game_dir);
        if !project_dir.exists() {
            return Err(format!(
                "game directory does not exist: {}",
                project_dir.display()
            ));
        }

        let port = allocate_free_port()?;
        let npm_bin = find_binary_in_path("npm").ok_or("`npm` not found in $PATH")?;

        let mut cmd = Command::new(npm_bin);
        cmd.current_dir(&project_dir)
            .args([
                "run",
                "dev",
                "--",
                "--port",
                &port.to_string(),
                "--strictPort",
            ])
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

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn Vite preview: {e}"))?;
        let log_tail = attach_log_readers(&mut child);

        if let Err(err) = wait_for_http_ok(port, timeout) {
            terminate_process_group(&mut child);
            return Err(err);
        }

        let url = format!("http://127.0.0.1:{port}/");
        self.active = Some(ActivePreview {
            mode: "web".to_string(),
            port: Some(port),
            url: Some(url),
            child,
            log_tail,
        });
        Ok(self.status(compositor))
    }

    pub fn start_godot(
        &mut self,
        workspace_root: &Path,
        worktree_path: Option<&Path>,
        game_dir: &str,
        width: u32,
        height: u32,
        compositor: &dyn CompositorAdapter,
    ) -> Result<PreviewStatus, String> {
        self.stop();
        let base = worktree_path.unwrap_or(workspace_root);
        let project_dir = base.join(game_dir);
        if !project_dir.exists() {
            return Err(format!(
                "Godot game directory does not exist: {}",
                project_dir.display()
            ));
        }

        if let Some(wt) = worktree_path {
            let copied = sync_godot_imported_cache(workspace_root, wt, game_dir)?;
            if copied {
                if let Some(godot_bin) = find_binary_in_path("godot") {
                    let _ = Command::new(godot_bin)
                        .arg("--headless")
                        .arg("--path")
                        .arg(&project_dir)
                        .arg("--import")
                        .status();
                }
            }
        }

        let godot_bin = find_binary_in_path("godot").ok_or("`godot` not found in $PATH")?;
        let res = format!("{width}x{height}");
        let mut cmd = Command::new(godot_bin);
        cmd.arg("--path")
            .arg(&project_dir)
            .arg("--windowed")
            .arg("--resolution")
            .arg(&res)
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

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn Godot preview: {e}"))?;
        let pid = child.id();
        let log_tail = attach_log_readers(&mut child);
        let _ = compositor.float_and_center_pid(pid, width, height);

        self.active = Some(ActivePreview {
            mode: "godot".to_string(),
            port: None,
            url: None,
            child,
            log_tail,
        });
        Ok(self.status(compositor))
    }

    pub fn stop(&mut self) {
        if let Some(mut active) = self.active.take() {
            terminate_process_group(&mut active.child);
        }
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

fn attach_log_readers(child: &mut Child) -> Arc<Mutex<VecDeque<String>>> {
    let buf = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES)));
    if let Some(stdout) = child.stdout.take() {
        let b = Arc::clone(&buf);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                push_log_line(&b, line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let b = Arc::clone(&buf);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                push_log_line(&b, line);
            }
        });
    }
    buf
}

fn push_log_line(buf: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut q) = buf.lock() {
        if q.len() >= MAX_LOG_LINES {
            q.pop_front();
        }
        q.push_back(line);
    }
}

fn terminate_process_group(child: &mut Child) {
    let pid = child.id() as libc::pid_t;
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
}
