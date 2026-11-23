use crate::types::{UpdateApplyResult, UpdateCheckResult};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Locates the local Git clone used to install/build Game Dev Hub.
pub fn resolve_install_repo_dir() -> Result<PathBuf, String> {
    if let Ok(env_dir) = std::env::var("GAME_HUB_DIR") {
        let candidate = PathBuf::from(env_dir.trim());
        if candidate.join(".git").exists() {
            return Ok(candidate);
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(home).join(".local/share/game-hub");
        if candidate.join(".git").exists() {
            return Ok(candidate);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            if ancestor.join(".git").exists() && ancestor.join("src-tauri").exists() {
                return Ok(ancestor.to_path_buf());
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join(".git").exists() && cwd.join("src-tauri").exists() {
            return Ok(cwd);
        }
    }

    Err("Repositório de instalação não encontrado (verifique GAME_HUB_DIR ou ~/.local/share/game-hub).".to_string())
}

fn run_git(repo_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(args)
        .output()
        .map_err(|e| format!("Falha ao executar git {}: {e}", args.join(" ")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git {} falhou: {detail}", args.join(" ")));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn detect_branch(repo_dir: &Path) -> String {
    match run_git(repo_dir, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(branch) if !branch.is_empty() && branch != "HEAD" => branch,
        _ => "master".to_string(),
    }
}

/// Fetches `origin/<branch>` and checks whether the local clone is behind.
pub fn check_for_updates_in_dir(repo_dir: &Path) -> Result<UpdateCheckResult, String> {
    let branch = detect_branch(repo_dir);
    run_git(repo_dir, &["fetch", "origin", &branch])?;

    let remote_ref = format!("origin/{branch}");
    let current_commit = run_git(repo_dir, &["rev-parse", "--short", "HEAD"])?;
    let remote_commit = run_git(repo_dir, &["rev-parse", "--short", &remote_ref])?;

    let range = format!("HEAD..{remote_ref}");
    let count_str = run_git(repo_dir, &["rev-list", "--count", &range])?;
    let commits_behind: u32 = count_str
        .parse()
        .map_err(|e| format!("Contagem inválida de commits: {e}"))?;

    let changelog = if commits_behind > 0 {
        let log_out = run_git(repo_dir, &["log", "--oneline", "-n", "20", &range])?;
        log_out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(ToString::to_string)
            .collect()
    } else {
        Vec::new()
    };

    Ok(UpdateCheckResult {
        repo_dir: repo_dir.to_string_lossy().to_string(),
        branch,
        current_commit,
        remote_commit,
        commits_behind,
        update_available: commits_behind > 0,
        changelog,
    })
}

fn tail_chars(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    text.chars().skip(total - max_chars).collect()
}

/// Pulls fast-forward commits from `origin` and rebuilds via `install.sh` if present.
pub fn apply_update_in_dir(repo_dir: &Path) -> Result<UpdateApplyResult, String> {
    let pull_out = run_git(repo_dir, &["pull", "--ff-only"])?;
    let mut combined_log = format!("$ git pull --ff-only\n{pull_out}\n");

    let install_sh = repo_dir.join("install.sh");
    if install_sh.exists() {
        let output = Command::new("bash")
            .arg(&install_sh)
            .current_dir(repo_dir)
            .env("GAME_HUB_DIR", repo_dir)
            .output()
            .map_err(|e| format!("Falha ao executar install.sh: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        combined_log.push_str("\n$ bash install.sh\n");
        combined_log.push_str(&stdout);
        if !stderr.is_empty() {
            combined_log.push_str(&stderr);
        }

        if !output.status.success() {
            return Err(format!(
                "Falha ao recompilar via install.sh:\n{}",
                tail_chars(&combined_log, 3000)
            ));
        }
    }

    let new_commit = run_git(repo_dir, &["rev-parse", "--short", "HEAD"])?;
    Ok(UpdateApplyResult {
        updated: true,
        new_commit: new_commit.clone(),
        message: format!(
            "Atualização aplicada para o commit {new_commit}. Reinicie o Game Dev Hub para usar a nova versão."
        ),
        output_log: tail_chars(&combined_log, 4000),
    })
}

pub fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let repo_dir = resolve_install_repo_dir()?;
    check_for_updates_in_dir(&repo_dir)
}

pub fn apply_update() -> Result<UpdateApplyResult, String> {
    let repo_dir = resolve_install_repo_dir()?;
    apply_update_in_dir(&repo_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn check_for_updates_detects_new_remote_commit() {
        let tmp = TempDir::new().unwrap();
        let bare_remote = tmp.path().join("remote.git");
        let seed_work = tmp.path().join("seed");
        let local_clone = tmp.path().join("local");

        git(tmp.path(), &["init", "--bare", bare_remote.to_str().unwrap()]);
        git(
            tmp.path(),
            &["clone", bare_remote.to_str().unwrap(), seed_work.to_str().unwrap()],
        );
        git(&seed_work, &["config", "user.name", "Test"]);
        git(&seed_work, &["config", "user.email", "test@example.com"]);
        git(&seed_work, &["checkout", "-b", "master"]);

        fs::write(seed_work.join("README.md"), "v1\n").unwrap();
        git(&seed_work, &["add", "."]);
        git(&seed_work, &["commit", "-m", "initial commit"]);
        git(&seed_work, &["push", "-u", "origin", "master"]);

        git(
            tmp.path(),
            &["clone", bare_remote.to_str().unwrap(), local_clone.to_str().unwrap()],
        );

        let up_to_date = check_for_updates_in_dir(&local_clone).unwrap();
        assert!(!up_to_date.update_available);
        assert_eq!(up_to_date.commits_behind, 0);
        assert!(up_to_date.changelog.is_empty());

        fs::write(seed_work.join("README.md"), "v2\n").unwrap();
        git(&seed_work, &["add", "."]);
        git(&seed_work, &["commit", "-m", "feat: add new awesome thing"]);
        git(&seed_work, &["push", "origin", "master"]);

        let behind = check_for_updates_in_dir(&local_clone).unwrap();
        assert!(behind.update_available);
        assert_eq!(behind.commits_behind, 1);
        assert_eq!(behind.changelog.len(), 1);
        assert!(behind.changelog[0].contains("feat: add new awesome thing"));
    }
}
