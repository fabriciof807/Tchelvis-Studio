use crate::workspace::{current_socket_path, sha256_hex};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

mod lens;
mod pi_adapter;
mod pi_setup;
mod tchelvis;

pub use lens::*;
pub use pi_adapter::*;
pub use pi_setup::*;
pub use tchelvis::*;

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

/// Resolves the Pi Durable CLI binary, falling back from legacy `dpi-backend` to `pi`.
pub fn resolve_pi_binary(bin_name: &str) -> Option<PathBuf> {
    if let Some(path) = find_binary_in_path(bin_name) {
        return Some(path);
    }
    if bin_name == "dpi-backend" {
        return find_binary_in_path("pi");
    }
    None
}

/// Returns the default Pi coding agent directory (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`).
pub fn default_pi_agent_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".pi/agent"))
}

/// Explicit Pi directories for the setup commands.
///
/// `None` on `AppState` means the defaults (`default_pi_agent_dir()` and
/// `workspace::config_dir()`); tests inject temp dirs instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiDirs {
    pub agent_dir: PathBuf,
    pub hub_config_dir: PathBuf,
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
