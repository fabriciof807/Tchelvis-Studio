use crate::types::{LoopRunState, MergeCheckResult, MergeResult};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git {:?}: {e}", args))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!(
            "git {:?} failed ({}): {} {}",
            args,
            out.status,
            stderr.trim(),
            stdout.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty() || run_id.contains('/') || run_id.contains('\\') || run_id.contains("..") {
        return Err(format!("invalid run_id: {run_id}"));
    }
    Ok(())
}

/// Resolves the worktree path for `run_id` from `.loops/runs/<run_id>/state.json`
/// or the default `.loops/worktrees/<run_id>`.
pub fn resolve_worktree_path(workspace_root: &Path, run_id: &str) -> Result<PathBuf, String> {
    validate_run_id(run_id)?;
    let state_path = workspace_root.join(".loops/runs").join(run_id).join("state.json");
    if state_path.exists() {
        if let Ok(raw) = fs::read_to_string(&state_path) {
            if let Ok(state) = serde_json::from_str::<LoopRunState>(&raw) {
                if let Some(wt) = state.worktree_path {
                    let p = PathBuf::from(&wt);
                    return Ok(if p.is_absolute() {
                        p
                    } else {
                        workspace_root.join(p)
                    });
                }
            }
        }
    }
    Ok(workspace_root.join(".loops/worktrees").join(run_id))
}

fn list_dirty_files(workspace_root: &Path) -> Result<Vec<String>, String> {
    let out = run_git(workspace_root, &["status", "--porcelain"])?;
    let mut dirty = Vec::new();
    for line in out.lines() {
        if line.len() >= 4 {
            let path = line[3..].trim();
            // Handle rename syntax `old -> new`
            let actual = path.rsplit(" -> ").next().unwrap_or(path);
            dirty.push(actual.to_string());
        }
    }
    Ok(dirty)
}

/// Checks whether merging the worktree branch for `run_id` into `default_branch`
/// collides with uncommitted dirty files in `workspace_root`.
pub fn check_worktree_merge(
    workspace_root: &Path,
    run_id: &str,
    default_branch: &str,
) -> Result<MergeCheckResult, String> {
    let wt_path = resolve_worktree_path(workspace_root, run_id)?;
    if !wt_path.exists() {
        return Err(format!(
            "worktree path does not exist: {}",
            wt_path.display()
        ));
    }
    let branch = run_git(&wt_path, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();

    let range = format!("{default_branch}...{branch}");
    let changed_out = run_git(workspace_root, &["diff", "--name-only", &range])?;
    let branch_changed: HashSet<String> = changed_out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let dirty = list_dirty_files(workspace_root)?;
    let conflicting_dirty_files: Vec<String> = dirty
        .into_iter()
        .filter(|f| branch_changed.contains(f))
        .collect();

    Ok(MergeCheckResult {
        can_merge: conflicting_dirty_files.is_empty(),
        conflicting_dirty_files,
        worktree_path: wt_path.to_string_lossy().to_string(),
        branch,
    })
}

/// Merges the loop worktree branch into `default_branch`, optionally stashing dirty
/// colliding files, and removes the worktree only after merge succeeds.
pub fn merge_worktree(
    workspace_root: &Path,
    run_id: &str,
    default_branch: &str,
    stash_dirty: bool,
) -> Result<MergeResult, String> {
    let check = check_worktree_merge(workspace_root, run_id, default_branch)?;
    if !check.can_merge && !stash_dirty {
        return Ok(MergeResult {
            merged: false,
            stashed: false,
            cleaned_worktree: false,
            message: format!(
                "Aborted merge due to dirty file collision: {}",
                check.conflicting_dirty_files.join(", ")
            ),
        });
    }

    let mut stashed = false;
    if !check.can_merge && stash_dirty {
        let msg = format!("game-hub auto-stash before merge {run_id}");
        run_git(workspace_root, &["stash", "push", "-u", "-m", &msg])?;
        stashed = true;
    }

    let current_branch = run_git(workspace_root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if current_branch != default_branch {
        run_git(workspace_root, &["checkout", default_branch])?;
    }

    let merge_msg = format!("Merge loop {run_id} ({})", check.branch);
    if let Err(err) = run_git(
        workspace_root,
        &["merge", "--no-ff", &check.branch, "-m", &merge_msg],
    ) {
        let _ = run_git(workspace_root, &["merge", "--abort"]);
        if stashed {
            let _ = run_git(workspace_root, &["stash", "pop"]);
        }
        return Err(format!("merge failed (worktree preserved): {err}"));
    }

    let cleaned_worktree = run_git(
        workspace_root,
        &["worktree", "remove", "--force", &check.worktree_path],
    )
    .is_ok();
    let _ = run_git(workspace_root, &["worktree", "prune"]);

    let mut extra = String::new();
    if stashed {
        if let Err(pop_err) = run_git(workspace_root, &["stash", "pop"]) {
            extra = format!(" (warning: git stash pop reported: {pop_err})");
        }
    }

    Ok(MergeResult {
        merged: true,
        stashed,
        cleaned_worktree,
        message: format!("Merged '{}' into '{}'{extra}", check.branch, default_branch),
    })
}

/// Lists non-main worktrees (e.g. `.loops/worktrees/*`) so the user can clean up orphans.
pub fn list_orphan_worktrees(workspace_root: &Path) -> Result<Vec<String>, String> {
    if !workspace_root.join(".git").exists() {
        return Ok(Vec::new());
    }
    let out = run_git(workspace_root, &["worktree", "list", "--porcelain"])?;
    let canonical_root = fs::canonicalize(workspace_root)
        .unwrap_or_else(|_| workspace_root.to_path_buf())
        .to_string_lossy()
        .to_string();

    let mut orphans = Vec::new();
    for line in out.lines() {
        if let Some(wt_path) = line.strip_prefix("worktree ") {
            let trimmed = wt_path.trim();
            if trimmed != canonical_root && trimmed != workspace_root.to_string_lossy() {
                orphans.push(trimmed.to_string());
            }
        }
    }
    Ok(orphans)
}

/// Force-removes a worktree for `run_id` and prunes Git worktree metadata.
pub fn cleanup_worktree(workspace_root: &Path, run_id: &str) -> Result<(), String> {
    let wt_path = resolve_worktree_path(workspace_root, run_id)?;
    if wt_path.exists() {
        let wt_str = wt_path.to_string_lossy().to_string();
        run_git(workspace_root, &["worktree", "remove", "--force", &wt_str])?;
    }
    let _ = run_git(workspace_root, &["worktree", "prune"]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn init_temp_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        run_git(dir.path(), &["init", "-b", "main"]).unwrap();
        run_git(dir.path(), &["config", "user.email", "test@example.com"]).unwrap();
        run_git(dir.path(), &["config", "user.name", "Test User"]).unwrap();
        fs::write(dir.path().join("README.md"), "base\n").unwrap();
        run_git(dir.path(), &["add", "README.md"]).unwrap();
        run_git(dir.path(), &["commit", "-m", "initial"]).unwrap();
        dir
    }

    #[test]
    fn dirty_collision_blocks_until_stashed_and_merges_cleanly() {
        let repo = init_temp_repo();
        let wt_path = repo.path().join(".loops/worktrees/run-1");
        fs::create_dir_all(wt_path.parent().unwrap()).unwrap();
        run_git(
            repo.path(),
            &[
                "worktree",
                "add",
                "-b",
                "loop/run-1",
                wt_path.to_str().unwrap(),
                "main",
            ],
        )
        .unwrap();

        // Modify README.md in the worktree and commit
        fs::write(wt_path.join("README.md"), "base\nfrom loop\n").unwrap();
        run_git(&wt_path, &["add", "README.md"]).unwrap();
        run_git(&wt_path, &["commit", "-m", "loop change"]).unwrap();

        // Create a dirty edit on README.md in the main workspace
        fs::write(repo.path().join("README.md"), "dirty local edit\n").unwrap();

        let check = check_worktree_merge(repo.path(), "run-1", "main").unwrap();
        assert!(!check.can_merge);
        assert_eq!(check.conflicting_dirty_files, vec!["README.md"]);

        // Merge with stash_dirty = false must abort cleanly
        let aborted = merge_worktree(repo.path(), "run-1", "main", false).unwrap();
        assert!(!aborted.merged);
        assert!(wt_path.exists());

        // Merge with stash_dirty = true must stash, merge, and clean worktree
        let merged = merge_worktree(repo.path(), "run-1", "main", true).unwrap();
        assert!(merged.merged);
        assert!(merged.stashed);
        assert!(merged.cleaned_worktree);
        assert!(!wt_path.exists());
    }

    #[test]
    fn orphan_worktrees_list_and_cleanup_work() {
        let repo = init_temp_repo();
        let wt_path = repo.path().join(".loops/worktrees/run-orphan");
        fs::create_dir_all(wt_path.parent().unwrap()).unwrap();
        run_git(
            repo.path(),
            &[
                "worktree",
                "add",
                "-b",
                "loop/orphan",
                wt_path.to_str().unwrap(),
                "main",
            ],
        )
        .unwrap();

        let orphans = list_orphan_worktrees(repo.path()).unwrap();
        assert_eq!(orphans.len(), 1);

        cleanup_worktree(repo.path(), "run-orphan").unwrap();
        assert!(list_orphan_worktrees(repo.path()).unwrap().is_empty());
    }
}
