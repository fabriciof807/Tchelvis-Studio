use crate::types::{
    CaptureSaved, FileTreeNode, GlobalConfig, MarkdownFilePayload, ProjectConfig, RecentWorkspace,
    WriteMarkdownResult,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_CAPTURE_QUOTA_BYTES: u64 = 200 * 1024 * 1024; // 200 MiB

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HubLock {
    pub pid: u32,
    pub socket_path: String,
}

/// Computes lowercase hex SHA-256 digest of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Returns `$XDG_RUNTIME_DIR/game-hub` (never `/tmp`), falling back to
/// `~/.local/state/game-hub/run` when `XDG_RUNTIME_DIR` is not set.
pub fn runtime_socket_dir() -> Result<PathBuf, String> {
    let base = if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        if !xdg.trim().is_empty() {
            PathBuf::from(xdg)
        } else {
            fallback_runtime_base()?
        }
    } else {
        fallback_runtime_base()?
    };
    let dir = base.join("game-hub");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create runtime socket dir: {e}"))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("failed to set runtime socket dir permissions: {e}"))?;
    Ok(dir)
}

fn fallback_runtime_base() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".local/state"))
}

/// Returns the per-process control socket path in `$XDG_RUNTIME_DIR/game-hub/<pid>.sock`.
pub fn current_socket_path() -> Result<PathBuf, String> {
    let dir = runtime_socket_dir()?;
    Ok(dir.join(format!("{}.sock", std::process::id())))
}

/// Returns `~/.config/game-hub`.
pub fn config_dir() -> Result<PathBuf, String> {
    if let Ok(xdg_cfg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg_cfg.trim().is_empty() {
            return Ok(PathBuf::from(xdg_cfg).join("game-hub"));
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".config/game-hub"))
}

/// Copies `defaults/` into `~/.config/game-hub/` on first run if files are absent.
pub fn ensure_default_config(defaults_dir: Option<&Path>) -> Result<GlobalConfig, String> {
    let cfg_root = config_dir()?;
    fs::create_dir_all(&cfg_root).map_err(|e| format!("failed to create config dir: {e}"))?;

    if let Some(src_root) = defaults_dir {
        if src_root.exists() {
            copy_missing_recursive(src_root, &cfg_root)?;
        }
    }

    let config_toml = cfg_root.join("config.toml");
    if config_toml.exists() {
        let raw = fs::read_to_string(&config_toml)
            .map_err(|e| format!("failed to read config.toml: {e}"))?;
        let parsed: GlobalConfig =
            toml::from_str(&raw).map_err(|e| format!("failed to parse config.toml: {e}"))?;
        Ok(parsed)
    } else {
        Ok(GlobalConfig::default())
    }
}

fn copy_missing_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("failed to create {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("failed to read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_missing_recursive(&src_path, &dst_path)?;
        } else if !dst_path.exists() {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("failed to copy {}: {e}", src_path.display()))?;
        }
    }
    Ok(())
}

/// Validates that `rel_path` stays strictly inside `workspace_root`, rejecting
/// absolute paths, `..` traversal, and symlinks pointing outside `workspace_root`.
pub fn canonicalize_in_workspace(workspace_root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if rel_path.trim().is_empty() {
        return Err("path must not be empty".to_string());
    }
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        return Err(format!("absolute paths are not allowed: {rel_path}"));
    }

    let mut clean_parts = Vec::new();
    for comp in rel.components() {
        match comp {
            Component::Normal(p) => clean_parts.push(p.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("path traversal is not allowed: {rel_path}"));
            }
        }
    }
    if clean_parts.is_empty() {
        return Err("path resolves to workspace root".to_string());
    }

    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("failed to canonicalize workspace root: {e}"))?;

    let candidate = clean_parts
        .iter()
        .fold(canonical_root.clone(), |acc, p| acc.join(p));

    if candidate.exists() {
        let resolved = fs::canonicalize(&candidate)
            .map_err(|e| format!("failed to canonicalize path {rel_path}: {e}"))?;
        if !resolved.starts_with(&canonical_root) {
            return Err(format!(
                "symlink escapes workspace root: {}",
                resolved.display()
            ));
        }
        return Ok(resolved);
    }

    // For non-existent target files (e.g. creating a new markdown note or capture),
    // canonicalize the deepest existing ancestor and verify it stays inside root.
    let mut ancestor = candidate.as_path();
    let mut tail = Vec::new();
    while !ancestor.exists() {
        if let Some(name) = ancestor.file_name() {
            tail.push(name.to_os_string());
        }
        ancestor = ancestor
            .parent()
            .ok_or_else(|| format!("invalid path: {rel_path}"))?;
    }
    let resolved_ancestor = fs::canonicalize(ancestor)
        .map_err(|e| format!("failed to canonicalize ancestor for {rel_path}: {e}"))?;
    if !resolved_ancestor.starts_with(&canonical_root) {
        return Err(format!(
            "target ancestor escapes workspace root: {}",
            resolved_ancestor.display()
        ));
    }
    let mut final_path = resolved_ancestor;
    for part in tail.into_iter().rev() {
        final_path.push(part);
    }
    Ok(final_path)
}

/// Returns `true` when `.hub/project.json` does NOT exist AND the directory
/// contains no entries other than `.git`.
pub fn is_workspace_uninitialized(workspace_root: &Path) -> Result<bool, String> {
    if workspace_root.join(".hub/project.json").exists() {
        return Ok(false);
    }
    let entries = fs::read_dir(workspace_root)
        .map_err(|e| format!("failed to read workspace dir: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() != ".git" {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Reads `.hub/project.json` if present.
pub fn read_project_config(workspace_root: &Path) -> Result<Option<ProjectConfig>, String> {
    let path = workspace_root.join(".hub/project.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read .hub/project.json: {e}"))?;
    let cfg: ProjectConfig = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse .hub/project.json: {e}"))?;
    Ok(Some(cfg))
}

/// Checks if a process with `pid` is currently alive.
pub fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: kill(pid, 0) only probes process existence without sending a signal.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Acquires `.hub/hub.lock` for `workspace_root`, or fails if another live Hub
/// instance already holds the lock.
pub fn acquire_workspace_lock(
    workspace_root: &Path,
    socket_path: &Path,
) -> Result<PathBuf, String> {
    let hub_dir = workspace_root.join(".hub");
    fs::create_dir_all(&hub_dir).map_err(|e| format!("failed to create .hub dir: {e}"))?;
    let lock_path = hub_dir.join("hub.lock");

    if lock_path.exists() {
        if let Ok(raw) = fs::read_to_string(&lock_path) {
            if let Ok(existing) = serde_json::from_str::<HubLock>(&raw) {
                if existing.pid != std::process::id() && is_pid_alive(existing.pid) {
                    return Err(format!(
                        "workspace already open in PID {} (socket: {})",
                        existing.pid, existing.socket_path
                    ));
                }
            }
        }
    }

    let lock = HubLock {
        pid: std::process::id(),
        socket_path: socket_path.to_string_lossy().to_string(),
    };
    let json = serde_json::to_string_pretty(&lock).map_err(|e| e.to_string())?;
    fs::write(&lock_path, json).map_err(|e| format!("failed to write hub.lock: {e}"))?;
    fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("failed to set hub.lock permissions: {e}"))?;
    Ok(lock_path)
}

/// Releases `.hub/hub.lock` if owned by the current process.
pub fn release_workspace_lock(workspace_root: &Path) {
    let lock_path = workspace_root.join(".hub/hub.lock");
    if let Ok(raw) = fs::read_to_string(&lock_path) {
        if let Ok(existing) = serde_json::from_str::<HubLock>(&raw) {
            if existing.pid == std::process::id() {
                let _ = fs::remove_file(&lock_path);
            }
        }
    }
}

/// Lists recent workspaces from `~/.config/game-hub/recent.json`.
pub fn list_recent_workspaces_in(cfg_dir: &Path) -> Result<Vec<RecentWorkspace>, String> {
    let path = cfg_dir.join("recent.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("failed to read recent.json: {e}"))?;
    let list: Vec<RecentWorkspace> =
        serde_json::from_str(&raw).map_err(|e| format!("failed to parse recent.json: {e}"))?;
    Ok(list)
}

/// Records `workspace_root` at the top of `recent.json` (deduplicated, max 20 entries).
pub fn record_recent_workspace_in(cfg_dir: &Path, workspace_root: &Path) -> Result<(), String> {
    fs::create_dir_all(cfg_dir).map_err(|e| format!("failed to create config dir: {e}"))?;
    let mut list = list_recent_workspaces_in(cfg_dir).unwrap_or_default();
    let canonical = fs::canonicalize(workspace_root)
        .unwrap_or_else(|_| workspace_root.to_path_buf())
        .to_string_lossy()
        .to_string();
    let name = workspace_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string());

    list.retain(|item| item.path != canonical);
    list.insert(
        0,
        RecentWorkspace {
            path: canonical,
            name,
            last_opened: now,
        },
    );
    list.truncate(20);

    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    fs::write(cfg_dir.join("recent.json"), json)
        .map_err(|e| format!("failed to write recent.json: {e}"))?;
    Ok(())
}

/// Builds an agnostic file tree for the workspace, skipping heavy/noisy folders.
pub fn build_workspace_tree(workspace_root: &Path) -> Result<Vec<FileTreeNode>, String> {
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("failed to canonicalize workspace root: {e}"))?;
    read_dir_tree(&canonical_root, &canonical_root)
}

fn should_skip_tree_entry(name: &str, rel_path: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target")
        || rel_path == "game/.godot"
        || rel_path == ".hub/hub.lock"
}

fn read_dir_tree(root: &Path, dir: &Path) -> Result<Vec<FileTreeNode>, String> {
    let mut nodes = Vec::new();
    let entries =
        fs::read_dir(dir).map_err(|e| format!("failed to read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        if should_skip_tree_entry(&name, &rel) {
            continue;
        }
        let is_dir = path.is_dir();
        let children = if is_dir {
            read_dir_tree(root, &path)?
        } else {
            Vec::new()
        };
        nodes.push(FileTreeNode {
            name,
            rel_path: rel,
            is_dir,
            children,
        });
    }
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(nodes)
}

/// Reads a UTF-8 Markdown file within the workspace and returns its content + SHA-256.
pub fn read_markdown_file(
    workspace_root: &Path,
    rel_path: &str,
) -> Result<MarkdownFilePayload, String> {
    let abs = canonicalize_in_workspace(workspace_root, rel_path)?;
    let bytes = fs::read(&abs).map_err(|e| format!("failed to read {rel_path}: {e}"))?;
    let content =
        String::from_utf8(bytes.clone()).map_err(|e| format!("{rel_path} is not valid UTF-8: {e}"))?;
    Ok(MarkdownFilePayload {
        rel_path: rel_path.to_string(),
        content,
        sha256: sha256_hex(&bytes),
    })
}

/// Writes a Markdown file within the workspace and returns the new SHA-256.
pub fn write_markdown_file(
    workspace_root: &Path,
    rel_path: &str,
    content: &str,
) -> Result<WriteMarkdownResult, String> {
    let abs = canonicalize_in_workspace(workspace_root, rel_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create parent dir: {e}"))?;
    }
    fs::write(&abs, content.as_bytes()).map_err(|e| format!("failed to write {rel_path}: {e}"))?;
    Ok(WriteMarkdownResult {
        rel_path: rel_path.to_string(),
        sha256: sha256_hex(content.as_bytes()),
    })
}

/// Saves `.hub/layout.json`.
pub fn save_layout(workspace_root: &Path, layout_json: &str) -> Result<(), String> {
    let hub_dir = workspace_root.join(".hub");
    fs::create_dir_all(&hub_dir).map_err(|e| format!("failed to create .hub dir: {e}"))?;
    fs::write(hub_dir.join("layout.json"), layout_json)
        .map_err(|e| format!("failed to save layout.json: {e}"))
}

/// Loads `.hub/layout.json` if present.
pub fn load_layout(workspace_root: &Path) -> Result<Option<String>, String> {
    let path = workspace_root.join(".hub/layout.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("failed to read layout.json: {e}"))?;
    Ok(Some(raw))
}

/// Lists preset names from `.hub/presets/*.json`.
pub fn list_presets(workspace_root: &Path) -> Result<Vec<String>, String> {
    let dir = workspace_root.join(".hub/presets");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut presets = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("failed to read presets dir: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                presets.push(stem.to_string());
            }
        }
    }
    presets.sort();
    Ok(presets)
}

/// Loads a named preset from `.hub/presets/<name>.json`.
pub fn load_preset(workspace_root: &Path, name: &str) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.is_empty() {
        return Err(format!("invalid preset name: {name}"));
    }
    let rel = format!(".hub/presets/{name}.json");
    let abs = canonicalize_in_workspace(workspace_root, &rel)?;
    fs::read_to_string(&abs).map_err(|e| format!("failed to read preset {name}: {e}"))
}

/// Saves a base64-encoded capture image into `.hub/captures/<filename>` and checks quota.
pub fn save_capture(
    workspace_root: &Path,
    filename: &str,
    bytes_base64: &str,
    quota_bytes: u64,
) -> Result<CaptureSaved, String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err(format!("invalid capture filename: {filename}"));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|e| format!("invalid base64 capture payload: {e}"))?;

    let rel_path = format!(".hub/captures/{filename}");
    let abs = canonicalize_in_workspace(workspace_root, &rel_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create captures dir: {e}"))?;
    }
    fs::write(&abs, &decoded).map_err(|e| format!("failed to write capture: {e}"))?;

    let captures_dir = workspace_root.join(".hub/captures");
    let total_bytes = dir_size_bytes(&captures_dir)?;
    Ok(CaptureSaved {
        rel_path,
        total_captures_bytes: total_bytes,
        quota_exceeded: total_bytes > quota_bytes,
    })
}

pub fn dir_size_bytes(dir: &Path) -> Result<u64, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in fs::read_dir(dir).map_err(|e| format!("failed to read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            total = total.saturating_add(dir_size_bytes(&path)?);
        } else if let Ok(meta) = entry.metadata() {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    #[test]
    fn canonicalize_blocks_traversal_and_escape_symlinks() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "top-secret").unwrap();

        fs::create_dir_all(root.path().join("gdd")).unwrap();
        fs::write(root.path().join("gdd/01.md"), "# GDD").unwrap();
        symlink(&secret, root.path().join("gdd/escape.md")).unwrap();

        assert!(canonicalize_in_workspace(root.path(), "gdd/01.md").is_ok());
        assert!(canonicalize_in_workspace(root.path(), "gdd/new-note.md").is_ok());
        assert!(canonicalize_in_workspace(root.path(), "../outside").is_err());
        assert!(canonicalize_in_workspace(root.path(), "/etc/passwd").is_err());
        assert!(canonicalize_in_workspace(root.path(), "gdd/escape.md").is_err());
    }

    #[test]
    fn uninitialized_check_handles_empty_and_dot_git_only() {
        let dir = TempDir::new().unwrap();
        assert!(is_workspace_uninitialized(dir.path()).unwrap());

        fs::create_dir(dir.path().join(".git")).unwrap();
        assert!(is_workspace_uninitialized(dir.path()).unwrap());

        fs::write(dir.path().join("README.md"), "hello").unwrap();
        assert!(!is_workspace_uninitialized(dir.path()).unwrap());

        fs::remove_file(dir.path().join("README.md")).unwrap();
        fs::create_dir_all(dir.path().join(".hub")).unwrap();
        fs::write(dir.path().join(".hub/project.json"), "{}").unwrap();
        assert!(!is_workspace_uninitialized(dir.path()).unwrap());
    }

    #[test]
    fn markdown_read_write_computes_sha256() {
        let dir = TempDir::new().unwrap();
        let wrote = write_markdown_file(dir.path(), "gdd/01.md", "# Hello\n").unwrap();
        let read = read_markdown_file(dir.path(), "gdd/01.md").unwrap();
        assert_eq!(wrote.sha256, read.sha256);
        assert_eq!(read.content, "# Hello\n");
    }

    #[test]
    fn save_capture_enforces_filename_and_quota() {
        let dir = TempDir::new().unwrap();
        let payload = base64::engine::general_purpose::STANDARD.encode(b"1234567890");

        assert!(save_capture(dir.path(), "../bad.png", &payload, 100).is_err());

        let res = save_capture(dir.path(), "shot.png", &payload, 5).unwrap();
        assert_eq!(res.rel_path, ".hub/captures/shot.png");
        assert_eq!(res.total_captures_bytes, 10);
        assert!(res.quota_exceeded);
    }

    #[test]
    fn lockfile_and_recent_workspaces_work() {
        let ws = TempDir::new().unwrap();
        let cfg = TempDir::new().unwrap();
        let sock = ws.path().join("123.sock");

        let lock_path = acquire_workspace_lock(ws.path(), &sock).unwrap();
        assert!(lock_path.exists());
        let mode = fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        release_workspace_lock(ws.path());
        assert!(!lock_path.exists());

        record_recent_workspace_in(cfg.path(), ws.path()).unwrap();
        let recents = list_recent_workspaces_in(cfg.path()).unwrap();
        assert_eq!(recents.len(), 1);
    }
}
