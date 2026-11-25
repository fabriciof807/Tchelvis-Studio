use crate::fs_watcher::parse_loop_run_state;
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

fn branch_exists(workspace_root: &Path, branch: &str) -> bool {
    let ref_name = format!("refs/heads/{branch}");
    run_git(workspace_root, &["show-ref", "--verify", "--quiet", &ref_name]).is_ok()
}

/// Resolves `default_branch`: if `refs/heads/<default_branch>` does not exist,
/// falls back to the repository's current checked-out branch (`HEAD`).
pub fn resolve_default_branch(workspace_root: &Path, default_branch: &str) -> Result<String, String> {
    if !default_branch.trim().is_empty() && branch_exists(workspace_root, default_branch) {
        return Ok(default_branch.to_string());
    }
    let current = run_git(workspace_root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if current.is_empty() || current == "HEAD" {
        return Err(format!(
            "default branch '{default_branch}' not found and HEAD is detached"
        ));
    }
    Ok(current)
}

fn read_run_state_if_present(workspace_root: &Path, run_id: &str) -> Option<LoopRunState> {
    let run_dir = workspace_root.join(".loops/runs").join(run_id);
    let state_path = run_dir.join("state.json");
    let raw = fs::read_to_string(&state_path).ok()?;
    parse_loop_run_state(run_id, &run_dir, &raw).ok()
}

fn resolve_worktree_and_branch(
    workspace_root: &Path,
    run_id: &str,
) -> Result<(Option<PathBuf>, String), String> {
    validate_run_id(run_id)?;
    let state = read_run_state_if_present(workspace_root, run_id);

    let candidate_wt = state
        .as_ref()
        .and_then(|s| s.worktree_path.as_ref())
        .map(|wt| {
            let p = PathBuf::from(wt);
            if p.is_absolute() {
                p
            } else {
                workspace_root.join(p)
            }
        })
        .filter(|p| p.exists())
        .or_else(|| {
            let wt = workspace_root.join(".loops/worktrees").join(run_id);
            wt.exists().then_some(wt)
        })
        .or_else(|| {
            let ws = workspace_root
                .join(".loops/runs")
                .join(run_id)
                .join("workspace");
            ws.exists().then_some(ws)
        });

    if let Some(wt_path) = candidate_wt {
        let branch = run_git(&wt_path, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        return Ok((Some(wt_path), branch));
    }

    if let Some(st) = state {
        if let Some(branch) = st.branch.filter(|b| !b.trim().is_empty()) {
            if branch_exists(workspace_root, &branch) {
                return Ok((None, branch));
            }
            return Err(format!(
                "loop branch '{branch}' for run '{run_id}' does not exist in repository"
            ));
        }
        if !st.workflow.trim().is_empty() {
            let conventional = format!("loop/{}-{run_id}", st.workflow);
            if branch_exists(workspace_root, &conventional) {
                return Ok((None, conventional));
            }
        }
    }

    let fallback_branch = format!("loop/{run_id}");
    if branch_exists(workspace_root, &fallback_branch) {
        return Ok((None, fallback_branch));
    }

    Err(format!(
        "no worktree or branch found for run '{run_id}'"
    ))
}

/// Resolves the worktree path for `run_id` from `.loops/runs/<run_id>/state.json`
/// or the default `.loops/worktrees/<run_id>`.
pub fn resolve_worktree_path(workspace_root: &Path, run_id: &str) -> Result<PathBuf, String> {
    validate_run_id(run_id)?;
    if let Some(state) = read_run_state_if_present(workspace_root, run_id) {
        if let Some(wt) = state.worktree_path {
            let p = PathBuf::from(&wt);
            return Ok(if p.is_absolute() {
                p
            } else {
                workspace_root.join(p)
            });
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

/// Checks whether merging the loop branch/worktree for `run_id` into `default_branch`
/// collides with uncommitted dirty files in `workspace_root`.
pub fn check_worktree_merge(
    workspace_root: &Path,
    run_id: &str,
    default_branch: &str,
) -> Result<MergeCheckResult, String> {
    let target_default = resolve_default_branch(workspace_root, default_branch)?;
    let (opt_wt, branch) = resolve_worktree_and_branch(workspace_root, run_id)?;

    let range = format!("{target_default}...{branch}");
    let changed_out = run_git(workspace_root, &["diff", "--name-only", &range])?;
    let branch_changed: HashSet<String> = changed_out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let dirty_files = list_dirty_files(workspace_root)?;
    let colliding: Vec<String> = dirty_files
        .iter()
        .filter(|f| branch_changed.contains(*f))
        .cloned()
        .collect();
    let can_merge = colliding.is_empty();

    Ok(MergeCheckResult {
        can_merge,
        can_merge_cleanly: can_merge,
        dirty_files,
        colliding_files: colliding.clone(),
        conflicting_dirty_files: colliding,
        requires_stash: !can_merge,
        worktree_path: opt_wt.map(|p| p.to_string_lossy().to_string()),
        branch,
    })
}

/// Merges the loop branch/worktree into `default_branch`, optionally stashing dirty
/// colliding files, and removes any worktree on disk only after merge succeeds.
pub fn merge_worktree(
    workspace_root: &Path,
    run_id: &str,
    default_branch: &str,
    stash_dirty: bool,
) -> Result<MergeResult, String> {
    let target_default = resolve_default_branch(workspace_root, default_branch)?;
    let check = check_worktree_merge(workspace_root, run_id, &target_default)?;
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
    if current_branch != target_default {
        run_git(workspace_root, &["checkout", &target_default])?;
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
        return Err(format!("merge failed (branch/worktree preserved): {err}"));
    }

    let cleaned_worktree = if let Some(wt_path) = check.worktree_path.as_deref() {
        let removed = run_git(workspace_root, &["worktree", "remove", "--force", wt_path]).is_ok();
        let _ = run_git(workspace_root, &["worktree", "prune"]);
        removed
    } else {
        false
    };

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
        message: format!("Merged '{}' into '{}'{extra}", check.branch, target_default),
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

    #[test]
    fn branch_only_loop_merge_and_master_fallback_work() {
        let repo = TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-b", "master"]).unwrap();
        run_git(repo.path(), &["config", "user.email", "test@example.com"]).unwrap();
        run_git(repo.path(), &["config", "user.name", "Test User"]).unwrap();
        fs::write(repo.path().join("README.md"), "base\n").unwrap();
        run_git(repo.path(), &["add", "README.md"]).unwrap();
        run_git(repo.path(), &["commit", "-m", "initial"]).unwrap();

        let run_id = "20261125-023057-eec8";
        let loop_branch = format!("loop/fast-worker-reviewer-{run_id}");
        run_git(repo.path(), &["checkout", "-b", &loop_branch]).unwrap();
        fs::write(repo.path().join("README.md"), "base\nfrom branch loop\n").unwrap();
        run_git(repo.path(), &["add", "README.md"]).unwrap();
        run_git(repo.path(), &["commit", "-m", "loop commit"]).unwrap();
        run_git(repo.path(), &["checkout", "master"]).unwrap();

        // Write real tchelvis state.json with no worktree on disk
        let run_dir = repo.path().join(".loops/runs").join(run_id);
        fs::create_dir_all(&run_dir).unwrap();
        fs::write(
            run_dir.join("state.json"),
            format!(
                r#"{{"schema_version":1,"run_id":"{run_id}","workflow":"fast-worker-reviewer","status":"PASS","branch":"{loop_branch}","started_at_ms":1795573858846,"executions":[]}}"#
            ),
        )
        .unwrap();

        // Dirty file collision on master while config says "main" -> falls back to "master"
        fs::write(repo.path().join("README.md"), "dirty edit\n").unwrap();
        let check = check_worktree_merge(repo.path(), run_id, "main").unwrap();
        assert!(!check.can_merge);
        assert!(!check.can_merge_cleanly);
        assert!(check.requires_stash);
        assert_eq!(check.worktree_path, None);
        assert_eq!(check.branch, loop_branch);
        assert_eq!(check.colliding_files, vec!["README.md"]);

        let merged = merge_worktree(repo.path(), run_id, "main", true).unwrap();
        assert!(merged.merged);
        assert!(merged.stashed);
        assert!(!merged.cleaned_worktree);
        assert!(merged.message.contains("into 'master'"));
    }
}
