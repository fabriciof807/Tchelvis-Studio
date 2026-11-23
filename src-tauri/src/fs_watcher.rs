use crate::types::LoopRunState;
use crate::workspace::sha256_hex;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const ECHO_WINDOW: Duration = Duration::from_secs(2);

/// Returns `true` if a path relative to the workspace root should be ignored by the watcher.
pub fn should_ignore_path(rel_path: &str) -> bool {
    let normalized = rel_path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.iter().any(|p| matches!(*p, ".git" | "node_modules" | "target")) {
        return true;
    }
    if normalized == "game/.godot" || normalized.starts_with("game/.godot/") {
        return true;
    }
    matches!(normalized.as_str(), ".hub/hub.lock" | ".hub/layout.json")
}

#[derive(Debug, Clone)]
struct EchoEntry {
    sha256: String,
    recorded_at: Instant,
}

/// Suppresses file-watcher echoes caused by the Hub's own writes.
#[derive(Debug, Default)]
pub struct EchoSuppressionCache {
    entries: HashMap<String, EchoEntry>,
}

impl EchoSuppressionCache {
    pub fn record_write(&mut self, rel_path: &str, sha256: String) {
        self.entries.insert(
            rel_path.to_string(),
            EchoEntry {
                sha256,
                recorded_at: Instant::now(),
            },
        );
    }

    /// Returns `true` if `current_sha256` matches a recent Hub write within `ECHO_WINDOW`.
    pub fn should_suppress(&mut self, rel_path: &str, current_sha256: &str) -> bool {
        if let Some(entry) = self.entries.get(rel_path) {
            if entry.recorded_at.elapsed() <= ECHO_WINDOW && entry.sha256 == current_sha256 {
                return true;
            }
        }
        false
    }
}

/// In-memory cache of the last valid `LoopRunState` per `run_id`, used when
/// `state.json` fails to parse mid-write.
#[derive(Debug, Default)]
pub struct LoopStateCache {
    last_valid: HashMap<String, LoopRunState>,
}

impl LoopStateCache {
    /// Reads `.loops/runs/<run_id>/state.json`. If JSON parsing fails, returns the
    /// last valid cached state for `run_id` instead of sleeping/retrying.
    pub fn read_state_or_cached(
        &mut self,
        run_id: &str,
        state_path: &Path,
    ) -> Result<LoopRunState, String> {
        let raw = fs::read_to_string(state_path)
            .map_err(|e| format!("failed to read {}: {e}", state_path.display()))?;
        match serde_json::from_str::<LoopRunState>(&raw) {
            Ok(state) => {
                self.last_valid.insert(run_id.to_string(), state.clone());
                Ok(state)
            }
            Err(parse_err) => {
                if let Some(cached) = self.last_valid.get(run_id) {
                    Ok(cached.clone())
                } else {
                    Err(format!(
                        "failed to parse {} and no cached state exists: {parse_err}",
                        state_path.display()
                    ))
                }
            }
        }
    }
}

pub fn is_terminal_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "done" | "failed" | "error" | "cancelled"
    )
}

/// Lists all loop runs found in `.loops/runs/*/state.json`.
pub fn list_loop_runs(
    workspace_root: &Path,
    cache: &mut LoopStateCache,
) -> Result<Vec<LoopRunState>, String> {
    let runs_dir = workspace_root.join(".loops/runs");
    if !runs_dir.exists() {
        return Ok(Vec::new());
    }
    let mut runs = Vec::new();
    for entry in fs::read_dir(&runs_dir).map_err(|e| format!("failed to read runs dir: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let run_dir = entry.path();
        if !run_dir.is_dir() {
            continue;
        }
        let state_path = run_dir.join("state.json");
        if !state_path.exists() {
            continue;
        }
        let run_id = entry.file_name().to_string_lossy().to_string();
        if let Ok(state) = cache.read_state_or_cached(&run_id, &state_path) {
            runs.push(state);
        }
    }
    runs.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    Ok(runs)
}

/// Scans `.loops/runs/*/state.json` on workspace open, finds terminal runs without
/// `.hub-notified`, writes `.hub-notified`, and returns them for UI/Pi notification.
pub fn reconcile_offline_completed_runs(
    workspace_root: &Path,
    cache: &mut LoopStateCache,
) -> Result<Vec<LoopRunState>, String> {
    let runs_dir = workspace_root.join(".loops/runs");
    if !runs_dir.exists() {
        return Ok(Vec::new());
    }
    let mut newly_completed = Vec::new();
    for entry in fs::read_dir(&runs_dir).map_err(|e| format!("failed to read runs dir: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let run_dir = entry.path();
        if !run_dir.is_dir() {
            continue;
        }
        let state_path = run_dir.join("state.json");
        let notified_marker = run_dir.join(".hub-notified");
        if !state_path.exists() || notified_marker.exists() {
            continue;
        }
        let run_id = entry.file_name().to_string_lossy().to_string();
        if let Ok(state) = cache.read_state_or_cached(&run_id, &state_path) {
            if is_terminal_status(&state.status) {
                let _ = fs::write(&notified_marker, b"notified\n");
                newly_completed.push(state);
            }
        }
    }
    newly_completed.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    Ok(newly_completed)
}

/// Reads `.loops/runs/<run_id>/report.html` (or `report.md` fallback).
pub fn read_loop_report(workspace_root: &Path, run_id: &str) -> Result<String, String> {
    if run_id.is_empty() || run_id.contains('/') || run_id.contains('\\') || run_id.contains("..") {
        return Err(format!("invalid run_id: {run_id}"));
    }
    let run_dir = workspace_root.join(".loops/runs").join(run_id);
    let html_path = run_dir.join("report.html");
    if html_path.exists() {
        return fs::read_to_string(&html_path)
            .map_err(|e| format!("failed to read report.html: {e}"));
    }
    let md_path = run_dir.join("report.md");
    if md_path.exists() {
        return fs::read_to_string(&md_path).map_err(|e| format!("failed to read report.md: {e}"));
    }
    Err(format!("no report found for run {run_id}"))
}

/// Active debounced file-system watcher handle for a workspace.
pub struct WorkspaceWatcher {
    _debouncer: Debouncer<notify::RecommendedWatcher>,
}

impl WorkspaceWatcher {
    pub fn start<F>(
        workspace_root: PathBuf,
        echo_cache: Arc<Mutex<EchoSuppressionCache>>,
        mut on_paths_changed: F,
    ) -> Result<Self, String>
    where
        F: FnMut(Vec<String>) + Send + 'static,
    {
        let root_for_cb = workspace_root.clone();
        let mut debouncer = new_debouncer(
            Duration::from_millis(250),
            move |res: DebounceEventResult| {
                if let Ok(events) = res {
                    let mut changed = Vec::new();
                    for ev in events {
                        if let Ok(rel) = ev.path.strip_prefix(&root_for_cb) {
                            let rel_str = rel.to_string_lossy().replace('\\', "/");
                            if should_ignore_path(&rel_str) {
                                continue;
                            }
                            if ev.path.is_file() {
                                if let Ok(bytes) = fs::read(&ev.path) {
                                    let hash = sha256_hex(&bytes);
                                    if let Ok(mut guard) = echo_cache.lock() {
                                        if guard.should_suppress(&rel_str, &hash) {
                                            continue;
                                        }
                                    }
                                }
                            }
                            if !changed.contains(&rel_str) {
                                changed.push(rel_str);
                            }
                        }
                    }
                    if !changed.is_empty() {
                        on_paths_changed(changed);
                    }
                }
            },
        )
        .map_err(|e| format!("failed to create file watcher: {e}"))?;

        debouncer
            .watcher()
            .watch(&workspace_root, RecursiveMode::Recursive)
            .map_err(|e| format!("failed to watch {}: {e}", workspace_root.display()))?;

        Ok(Self {
            _debouncer: debouncer,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ignore_filters_match_spec() {
        assert!(should_ignore_path(".git/HEAD"));
        assert!(should_ignore_path("game/node_modules/pkg/index.js"));
        assert!(should_ignore_path("game/.godot/imported/tex.ctex"));
        assert!(should_ignore_path("src-tauri/target/debug/app"));
        assert!(should_ignore_path(".hub/hub.lock"));
        assert!(should_ignore_path(".hub/layout.json"));
        assert!(!should_ignore_path("gdd/01-visao-geral.md"));
        assert!(!should_ignore_path(".loops/runs/run-1/state.json"));
    }

    #[test]
    fn echo_suppression_blocks_matching_sha256_and_allows_external_edit() {
        let mut cache = EchoSuppressionCache::default();
        let h1 = sha256_hex(b"hello");
        let h2 = sha256_hex(b"external edit");
        cache.record_write("gdd/01.md", h1.clone());

        assert!(cache.should_suppress("gdd/01.md", &h1));
        assert!(!cache.should_suppress("gdd/01.md", &h2));
        assert!(!cache.should_suppress("gdd/02.md", &h1));
    }

    #[test]
    fn loop_state_cache_preserves_last_valid_on_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let state_path = dir.path().join("state.json");
        let valid = LoopRunState {
            run_id: "run-1".to_string(),
            workflow: "implement".to_string(),
            title: "Player dash".to_string(),
            status: "running".to_string(),
            current_stage: "coding".to_string(),
            stages: vec!["plan".into(), "coding".into(), "test".into()],
            worktree_path: Some(".loops/worktrees/run-1".into()),
            exit_summary: vec![],
        };
        fs::write(&state_path, serde_json::to_string(&valid).unwrap()).unwrap();

        let mut cache = LoopStateCache::default();
        let first = cache.read_state_or_cached("run-1", &state_path).unwrap();
        assert_eq!(first.current_stage, "coding");

        // Simulate partial/corrupt write
        fs::write(&state_path, "{ invalid json").unwrap();
        let fallback = cache.read_state_or_cached("run-1", &state_path).unwrap();
        assert_eq!(fallback, valid);
    }

    #[test]
    fn offline_reconciliation_marks_hub_notified_once() {
        let dir = TempDir::new().unwrap();
        let run_dir = dir.path().join(".loops/runs/run-42");
        fs::create_dir_all(&run_dir).unwrap();
        let state = LoopRunState {
            run_id: "run-42".to_string(),
            workflow: "implement".to_string(),
            title: "Inventory".to_string(),
            status: "completed".to_string(),
            current_stage: "done".to_string(),
            stages: vec!["done".into()],
            worktree_path: None,
            exit_summary: vec!["All tests passed".into()],
        };
        fs::write(
            run_dir.join("state.json"),
            serde_json::to_string(&state).unwrap(),
        )
        .unwrap();

        let mut cache = LoopStateCache::default();
        let first = reconcile_offline_completed_runs(dir.path(), &mut cache).unwrap();
        assert_eq!(first.len(), 1);
        assert!(run_dir.join(".hub-notified").exists());

        // Second call must not re-emit already notified runs
        let second = reconcile_offline_completed_runs(dir.path(), &mut cache).unwrap();
        assert!(second.is_empty());
    }
}
