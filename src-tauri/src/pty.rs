use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Manages embedded terminal sessions backed by `portable-pty`.
#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawns `$SHELL` (falling back to `/bin/sh`) inside `cwd` with the given dimensions.
    pub fn spawn<F>(
        &self,
        cwd: &Path,
        cols: u16,
        rows: u16,
        mut on_output: F,
    ) -> Result<String, String>
    where
        F: FnMut(String, String) + Send + 'static,
    {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open PTY: {e}"))?;

        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string());

        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell {shell}: {e}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone PTY reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to take PTY writer: {e}"))?;

        let session_id = format!("pty-{}", NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed));
        let sid_for_thread = session_id.clone();

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        on_output(sid_for_thread.clone(), text);
                    }
                }
            }
        });

        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| "PTY session mutex poisoned".to_string())?;
        guard.insert(
            session_id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
            },
        );
        Ok(session_id)
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| "PTY session mutex poisoned".to_string())?;
        let session = guard
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown PTY session: {session_id}"))?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("PTY write failed: {e}"))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("PTY flush failed: {e}"))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "PTY session mutex poisoned".to_string())?;
        let session = guard
            .get(session_id)
            .ok_or_else(|| format!("unknown PTY session: {session_id}"))?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY resize failed: {e}"))
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let session = {
            let mut guard = self
                .sessions
                .lock()
                .map_err(|_| "PTY session mutex poisoned".to_string())?;
            guard.remove(session_id)
        };
        if let Some(mut s) = session {
            terminate_child_process_group(&mut s.child);
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let drained: Vec<PtySession> = {
            if let Ok(mut guard) = self.sessions.lock() {
                guard.drain().map(|(_, v)| v).collect()
            } else {
                Vec::new()
            }
        };
        for mut s in drained {
            terminate_child_process_group(&mut s.child);
        }
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// Terminates a PTY child and its process group (`SIGTERM` -> timeout -> `SIGKILL`).
pub fn terminate_child_process_group(child: &mut Box<dyn Child + Send + Sync>) {
    if let Some(pid) = child.process_id() {
        let pgid = pid as libc::pid_t;
        // SAFETY: sending SIGTERM to the child's process group (best-effort).
        unsafe {
            libc::killpg(pgid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: escalating to SIGKILL on process group if still alive.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tempfile::TempDir;

    #[test]
    fn pty_spawn_write_resize_and_kill_works() {
        let dir = TempDir::new().unwrap();
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel();

        let sid = mgr
            .spawn(dir.path(), 80, 24, move |_id, chunk| {
                let _ = tx.send(chunk);
            })
            .unwrap();

        mgr.resize(&sid, 100, 30).unwrap();
        mgr.write(&sid, "echo HUB_PTY_OK\n").unwrap();

        let mut collected = String::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                collected.push_str(&chunk);
                if collected.contains("HUB_PTY_OK") {
                    break;
                }
            }
        }
        assert!(
            collected.contains("HUB_PTY_OK"),
            "expected PTY output to contain HUB_PTY_OK, got: {collected:?}"
        );

        mgr.kill(&sid).unwrap();
        // Writing to a killed session must error cleanly
        assert!(mgr.write(&sid, "echo nope\n").is_err());
    }
}
