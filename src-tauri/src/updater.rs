use crate::types::{UpdateApplyResult, UpdateCheckResult};
use crate::workspace::config_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_REPO: &str = "fabriciof807/Tchelvis-Studio";
const PREBUILT_ASSET_NAME: &str = "game-hub-linux-x86_64.tar.gz";
const UPDATE_CHECK_STEP_TIMEOUT: Duration = Duration::from_secs(15);
const UPDATE_CHECK_TOTAL_TIMEOUT: Duration = Duration::from_secs(25);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

static ACTIVE_CHECK_CANCEL: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Signals any in-flight `check_for_updates` operation to abort immediately.
pub fn cancel_update_check() {
    if let Ok(guard) = ACTIVE_CHECK_CANCEL.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

struct CheckContext {
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}

impl CheckContext {
    fn start(total_timeout: Duration) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = ACTIVE_CHECK_CANCEL.lock() {
            if let Some(prev) = guard.replace(Arc::clone(&flag)) {
                prev.store(true, Ordering::SeqCst);
            }
        }
        Self {
            cancel: flag,
            deadline: Instant::now() + total_timeout,
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn remaining_timeout(&self, max_step: Duration) -> Result<Duration, String> {
        if self.is_cancelled() {
            return Err("Busca de atualizações cancelada pelo usuário.".to_string());
        }
        let now = Instant::now();
        if now >= self.deadline {
            return Err(
                "Tempo limite esgotado ao buscar atualizações. Verifique sua conexão.".to_string(),
            );
        }
        Ok((self.deadline - now).min(max_step))
    }
}

fn run_command_with_timeout(
    mut cmd: Command,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
    label: &str,
) -> Result<Output, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Falha ao executar {label}: {e}"))?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_handle.join().unwrap_or_default();
                let stderr = stderr_handle.join().unwrap_or_default();
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    return Err("Busca de atualizações cancelada pelo usuário.".to_string());
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    return Err(format!(
                        "Tempo limite esgotado ({}s) ao executar {label}.",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(format!("Falha ao aguardar {label}: {e}"));
            }
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct InstallState {
    pub channel: String,
    pub tag: Option<String>,
    pub commit: String,
}

#[derive(Deserialize, Debug, Clone)]
struct PublicApiAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize, Debug, Clone)]
struct PublicApiRelease {
    tag_name: String,
    prerelease: bool,
    draft: bool,
    target_commitish: Option<String>,
    body: Option<String>,
    assets: Vec<PublicApiAsset>,
}

#[derive(Deserialize, Debug, Clone)]
struct GhReleaseListItem {
    #[serde(rename = "tagName")]
    tag_name: String,
    #[serde(rename = "isPrerelease")]
    is_prerelease: bool,
    #[serde(rename = "isDraft")]
    is_draft: bool,
}

#[derive(Deserialize, Debug, Clone)]
struct GhReleaseAsset {
    name: String,
    url: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct GhReleaseView {
    #[serde(rename = "tagName")]
    tag_name: String,
    #[serde(rename = "targetCommitish")]
    target_commitish: Option<String>,
    body: Option<String>,
    assets: Vec<GhReleaseAsset>,
}

#[derive(Deserialize, Debug, Clone)]
struct ReleaseManifest {
    commit: Option<String>,
    tag: Option<String>,
}

pub fn normalize_channel(channel: Option<&str>) -> &'static str {
    match channel.map(str::trim).unwrap_or("stable").to_ascii_lowercase().as_str() {
        "nightly" => "nightly",
        _ => "stable",
    }
}

fn repo_slug() -> String {
    std::env::var("GAME_HUB_REPO")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_REPO.to_string())
}

fn bin_install_path() -> Result<PathBuf, String> {
    if let Ok(bin_dir) = std::env::var("GAME_HUB_BIN_DIR") {
        if !bin_dir.trim().is_empty() {
            return Ok(PathBuf::from(bin_dir.trim()).join("game-hub"));
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".local/bin/game-hub"))
}

fn read_install_state() -> Option<InstallState> {
    let cfg = config_dir().ok()?;
    let path = cfg.join("install-state.json");
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_install_state(state: &InstallState) {
    if let Ok(cfg) = config_dir() {
        let _ = fs::create_dir_all(&cfg);
        if let Ok(json) = serde_json::to_string_pretty(state) {
            let _ = fs::write(cfg.join("install-state.json"), json);
        }
    }
}

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

fn run_git_with_ctx(
    repo_dir: &Path,
    args: &[&str],
    ctx: Option<&CheckContext>,
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo_dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");

    let output = if let Some(c) = ctx {
        let timeout = c.remaining_timeout(UPDATE_CHECK_STEP_TIMEOUT)?;
        run_command_with_timeout(
            cmd,
            timeout,
            Some(c.cancel.as_ref()),
            &format!("git {}", args.first().copied().unwrap_or("")),
        )?
    } else {
        cmd.output()
            .map_err(|e| format!("Falha ao executar git {}: {e}", args.join(" ")))?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git {} falhou: {detail}", args.join(" ")));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git(repo_dir: &Path, args: &[&str]) -> Result<String, String> {
    run_git_with_ctx(repo_dir, args, None)
}

fn detect_local_commit(repo_dir: Option<&Path>) -> String {
    if let Some(state) = read_install_state() {
        if !state.commit.is_empty() {
            return state.commit;
        }
    }
    if let Some(built) = option_env!("HUB_BUILD_COMMIT") {
        if !built.is_empty() && built != "unknown" {
            return built.to_string();
        }
    }
    if let Some(dir) = repo_dir {
        if let Ok(sha) = run_git(dir, &["rev-parse", "--short", "HEAD"]) {
            if !sha.is_empty() {
                return sha;
            }
        }
    }
    "unknown".to_string()
}

fn detect_branch_for_channel_with_ctx(
    repo_dir: &Path,
    channel: &str,
    ctx: Option<&CheckContext>,
) -> Result<String, String> {
    let preferred = if channel == "nightly" {
        ["nightly", "master"]
    } else {
        ["stable", "master"]
    };

    for branch in preferred {
        match run_git_with_ctx(
            repo_dir,
            &["ls-remote", "--exit-code", "--heads", "origin", branch],
            ctx,
        ) {
            Ok(_) => return Ok(branch.to_string()),
            Err(_) if ctx.is_some_and(CheckContext::is_cancelled) => {
                return Err("Busca de atualizações cancelada pelo usuário.".to_string());
            }
            Err(e) if e.contains("Tempo limite esgotado") => return Err(e),
            Err(_) => {}
        }
    }

    match run_git(repo_dir, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(branch) if !branch.is_empty() && branch != "HEAD" => Ok(branch),
        _ => Ok("master".to_string()),
    }
}

fn detect_branch_for_channel(repo_dir: &Path, channel: &str) -> String {
    detect_branch_for_channel_with_ctx(repo_dir, channel, None)
        .unwrap_or_else(|_| "master".to_string())
}

fn curl_get_bytes(url: &str, ctx: Option<&CheckContext>) -> Result<Option<Vec<u8>>, String> {
    let timeout = match ctx {
        Some(c) => c.remaining_timeout(UPDATE_CHECK_STEP_TIMEOUT)?,
        None => UPDATE_DOWNLOAD_TIMEOUT,
    };
    let max_secs = timeout.as_secs().max(1).to_string();
    let connect_secs = timeout.as_secs().min(8).max(1).to_string();

    let mut cmd = Command::new("curl");
    cmd.args([
        "-fsSL",
        "--connect-timeout",
        &connect_secs,
        "--max-time",
        &max_secs,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "User-Agent: Tchelvis-Studio-Updater",
    ]);
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            cmd.args(["-H", &format!("Authorization: Bearer {trimmed}")]);
        }
    }
    cmd.arg(url);

    let out = run_command_with_timeout(
        cmd,
        timeout,
        ctx.map(|c| c.cancel.as_ref()),
        "curl",
    )?;
    Ok(out.status.success().then_some(out.stdout))
}

fn fetch_github_compare_changelog(
    repo: &str,
    base: &str,
    head: &str,
    ctx: Option<&CheckContext>,
) -> Result<Vec<String>, String> {
    let api_url = format!("https://api.github.com/repos/{repo}/compare/{base}...{head}");
    if let Some(bytes) = curl_get_bytes(&api_url, ctx)? {
        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(commits) = json.get("commits").and_then(|v| v.as_array()) {
                let list: Vec<String> = commits
                    .iter()
                    .rev()
                    .take(25)
                    .rev()
                    .filter_map(|c| {
                        let sha = c.get("sha")?.as_str()?;
                        let msg = c
                            .pointer("/commit/message")?
                            .as_str()?
                            .lines()
                            .next()
                            .unwrap_or("")
                            .trim();
                        let short = &sha[..sha.len().min(7)];
                        Some(format!("{short} {msg}"))
                    })
                    .collect();
                if !list.is_empty() {
                    return Ok(list);
                }
            }
        }
    }

    let timeout = match ctx {
        Some(c) => c.remaining_timeout(UPDATE_CHECK_STEP_TIMEOUT)?,
        None => UPDATE_CHECK_STEP_TIMEOUT,
    };
    let endpoint = format!("repos/{repo}/compare/{base}...{head}");
    let mut cmd = Command::new("gh");
    cmd.args([
        "api",
        &endpoint,
        "--jq",
        r#".commits[-25:][] | "\(.sha[0:7]) \(.commit.message | split("\n")[0])""#,
    ]);

    let Ok(output) = run_command_with_timeout(cmd, timeout, ctx.map(|c| c.cancel.as_ref()), "gh api")
    else {
        if ctx.is_some_and(CheckContext::is_cancelled) {
            return Err("Busca de atualizações cancelada pelo usuário.".to_string());
        }
        return Ok(Vec::new());
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(ToString::to_string)
        .collect())
}

fn fetch_release_for_channel_public_api(
    repo: &str,
    channel: &str,
    ctx: Option<&CheckContext>,
) -> Result<Option<PublicApiRelease>, String> {
    let url = format!("https://api.github.com/repos/{repo}/releases?per_page=15");
    let Some(bytes) = curl_get_bytes(&url, ctx)? else {
        return Ok(None);
    };
    let Ok(releases) = serde_json::from_slice::<Vec<PublicApiRelease>>(&bytes) else {
        return Ok(None);
    };
    let found = if channel == "nightly" {
        releases
            .into_iter()
            .find(|r| !r.draft && (r.tag_name == "nightly" || r.prerelease))
    } else {
        releases.into_iter().find(|r| !r.draft && !r.prerelease)
    };
    Ok(found)
}

fn fetch_release_for_channel_gh(
    repo: &str,
    channel: &str,
    ctx: Option<&CheckContext>,
) -> Result<Option<PublicApiRelease>, String> {
    let timeout = match ctx {
        Some(c) => c.remaining_timeout(UPDATE_CHECK_STEP_TIMEOUT)?,
        None => UPDATE_CHECK_STEP_TIMEOUT,
    };
    let mut list_cmd = Command::new("gh");
    list_cmd.args([
        "release",
        "list",
        "--repo",
        repo,
        "--limit",
        "15",
        "--json",
        "tagName,isPrerelease,isDraft",
    ]);
    let list_out = match run_command_with_timeout(
        list_cmd,
        timeout,
        ctx.map(|c| c.cancel.as_ref()),
        "gh release list",
    ) {
        Ok(o) => o,
        Err(e) if ctx.is_some_and(CheckContext::is_cancelled) || e.contains("Tempo limite") => {
            return Err(e)
        }
        Err(_) => return Ok(None),
    };
    if !list_out.status.success() {
        return Ok(None);
    }

    let Ok(releases) = serde_json::from_slice::<Vec<GhReleaseListItem>>(&list_out.stdout) else {
        return Ok(None);
    };
    let Some(selected) = (if channel == "nightly" {
        releases
            .into_iter()
            .find(|r| !r.is_draft && (r.tag_name == "nightly" || r.is_prerelease))
    } else {
        releases
            .into_iter()
            .find(|r| !r.is_draft && !r.is_prerelease)
    }) else {
        return Ok(None);
    };

    let timeout = match ctx {
        Some(c) => c.remaining_timeout(UPDATE_CHECK_STEP_TIMEOUT)?,
        None => UPDATE_CHECK_STEP_TIMEOUT,
    };
    let mut view_cmd = Command::new("gh");
    view_cmd.args([
        "release",
        "view",
        &selected.tag_name,
        "--repo",
        repo,
        "--json",
        "tagName,targetCommitish,body,assets",
    ]);
    let view_out = match run_command_with_timeout(
        view_cmd,
        timeout,
        ctx.map(|c| c.cancel.as_ref()),
        "gh release view",
    ) {
        Ok(o) => o,
        Err(e) if ctx.is_some_and(CheckContext::is_cancelled) || e.contains("Tempo limite") => {
            return Err(e)
        }
        Err(_) => return Ok(None),
    };
    if !view_out.status.success() {
        return Ok(None);
    }

    let Ok(view) = serde_json::from_slice::<GhReleaseView>(&view_out.stdout) else {
        return Ok(None);
    };
    Ok(Some(PublicApiRelease {
        tag_name: view.tag_name,
        prerelease: selected.is_prerelease,
        draft: selected.is_draft,
        target_commitish: view.target_commitish,
        body: view.body,
        assets: view
            .assets
            .into_iter()
            .map(|a| PublicApiAsset {
                name: a.name,
                browser_download_url: a.url.unwrap_or_default(),
            })
            .collect(),
    }))
}

fn download_release_asset(
    repo: &str,
    tag: &str,
    asset_name: &str,
    browser_url: Option<&str>,
    dst_dir: &Path,
    ctx: Option<&CheckContext>,
) -> Result<(), String> {
    let dst_file = dst_dir.join(asset_name);
    if let Some(url) = browser_url.filter(|u| !u.is_empty()) {
        if let Some(bytes) = curl_get_bytes(url, ctx)? {
            fs::write(&dst_file, &bytes)
                .map_err(|e| format!("Falha ao gravar {asset_name}: {e}"))?;
            return Ok(());
        }
    }

    let fallback_url = format!("https://github.com/{repo}/releases/download/{tag}/{asset_name}");
    if let Some(bytes) = curl_get_bytes(&fallback_url, ctx)? {
        fs::write(&dst_file, &bytes)
            .map_err(|e| format!("Falha ao gravar {asset_name}: {e}"))?;
        return Ok(());
    }

    let timeout = match ctx {
        Some(c) => c.remaining_timeout(UPDATE_CHECK_STEP_TIMEOUT)?,
        None => UPDATE_DOWNLOAD_TIMEOUT,
    };
    let mut cmd = Command::new("gh");
    cmd.args([
        "release",
        "download",
        tag,
        "--repo",
        repo,
        "-p",
        asset_name,
        "-D",
        dst_dir.to_str().unwrap_or("/tmp"),
    ]);
    let dl = run_command_with_timeout(
        cmd,
        timeout,
        ctx.map(|c| c.cancel.as_ref()),
        "gh release download",
    )?;
    if !dl.status.success() {
        return Err(format!(
            "Download de {asset_name} falhou: {}",
            String::from_utf8_lossy(&dl.stderr)
        ));
    }
    Ok(())
}

fn check_github_release_channel(
    channel: &str,
    repo_dir: Option<&Path>,
    ctx: Option<&CheckContext>,
) -> Result<Option<UpdateCheckResult>, String> {
    let repo = repo_slug();
    let view = match fetch_release_for_channel_public_api(&repo, channel, ctx)? {
        Some(v) => v,
        None => match fetch_release_for_channel_gh(&repo, channel, ctx)? {
            Some(v) => v,
            None => return Ok(None),
        },
    };

    let has_prebuilt_asset = view.assets.iter().any(|a| a.name == PREBUILT_ASSET_NAME);
    let manifest_asset = view.assets.iter().find(|a| a.name == "manifest.json");

    let mut manifest_commit: Option<String> = None;
    if let Some(m_asset) = manifest_asset {
        if let Ok(tmp) = tempfile::tempdir() {
            match download_release_asset(
                &repo,
                &view.tag_name,
                "manifest.json",
                Some(&m_asset.browser_download_url),
                tmp.path(),
                ctx,
            ) {
                Ok(()) => {
                    if let Ok(raw) = fs::read_to_string(tmp.path().join("manifest.json")) {
                        if let Ok(parsed) = serde_json::from_str::<ReleaseManifest>(&raw) {
                            manifest_commit = parsed.commit.or(parsed.tag);
                        }
                    }
                }
                Err(e) if ctx.is_some_and(CheckContext::is_cancelled) || e.contains("Tempo limite") => {
                    return Err(e);
                }
                Err(_) => {}
            }
        }
    }

    let remote_commit = manifest_commit
        .or_else(|| {
            view.target_commitish
                .as_deref()
                .map(|s| s.chars().take(7).collect::<String>())
        })
        .unwrap_or_else(|| view.tag_name.clone());

    let install_state = read_install_state();
    let current_commit = detect_local_commit(repo_dir);

    let channel_changed = install_state
        .as_ref()
        .map(|s| s.channel != channel)
        .unwrap_or(false);
    let tag_changed = install_state
        .as_ref()
        .and_then(|s| s.tag.as_deref())
        .map(|t| t != view.tag_name)
        .unwrap_or(false);
    let commit_changed = current_commit != remote_commit;
    let update_available = commit_changed || channel_changed || tag_changed;

    let mut changelog: Vec<String> = Vec::new();
    let mut commits_behind: u32 = if update_available { 1 } else { 0 };

    if update_available {
        if let Some(dir) = repo_dir {
            match run_git_with_ctx(dir, &["fetch", "origin", "--tags"], ctx) {
                Ok(_) if current_commit != "unknown" => {
                    let range = format!("{current_commit}..{remote_commit}");
                    if let Ok(count_str) = run_git(dir, &["rev-list", "--count", &range]) {
                        if let Ok(n) = count_str.parse::<u32>() {
                            commits_behind = n.max(1);
                        }
                    }
                    if let Ok(log_out) =
                        run_git(dir, &["log", "--no-merges", "--oneline", "-n", "20", &range])
                    {
                        changelog = log_out
                            .lines()
                            .map(str::trim)
                            .filter(|l| !l.is_empty())
                            .map(ToString::to_string)
                            .collect();
                    }
                }
                Err(e) if ctx.is_some_and(CheckContext::is_cancelled) || e.contains("Tempo limite") => {
                    return Err(e);
                }
                _ => {}
            }
        }
    }

    if changelog.is_empty()
        && update_available
        && current_commit != "unknown"
        && current_commit != remote_commit
    {
        match fetch_github_compare_changelog(&repo, &current_commit, &remote_commit, ctx) {
            Ok(list) => changelog = list,
            Err(e) if ctx.is_some_and(CheckContext::is_cancelled) || e.contains("Tempo limite") => {
                return Err(e);
            }
            Err(_) => {}
        }
    }

    if changelog.is_empty() && update_available {
        if let Some(body) = view.body {
            changelog = body
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with("Recent commits:"))
                .take(15)
                .map(ToString::to_string)
                .collect();
        }
    }

    Ok(Some(UpdateCheckResult {
        channel: channel.to_string(),
        source: "github-release".to_string(),
        repo_dir: repo_dir
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("github:{repo}")),
        branch: channel.to_string(),
        release_tag: Some(view.tag_name),
        current_commit,
        remote_commit,
        commits_behind,
        update_available,
        has_prebuilt_asset,
        changelog,
    }))
}

/// Fetches `origin/<channel-branch>` and checks whether the local clone is behind.
pub fn check_for_updates_in_dir(
    repo_dir: &Path,
    channel: &str,
) -> Result<UpdateCheckResult, String> {
    check_for_updates_in_dir_with_ctx(repo_dir, channel, None)
}

fn check_for_updates_in_dir_with_ctx(
    repo_dir: &Path,
    channel: &str,
    ctx: Option<&CheckContext>,
) -> Result<UpdateCheckResult, String> {
    let channel = normalize_channel(Some(channel));
    let branch = detect_branch_for_channel_with_ctx(repo_dir, channel, ctx)?;
    run_git_with_ctx(repo_dir, &["fetch", "origin", &branch], ctx)?;

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

    let install_state = read_install_state();
    let channel_changed = install_state
        .as_ref()
        .map(|s| s.channel != channel)
        .unwrap_or(false);

    Ok(UpdateCheckResult {
        channel: channel.to_string(),
        source: "git-branch".to_string(),
        repo_dir: repo_dir.to_string_lossy().to_string(),
        branch,
        release_tag: None,
        current_commit: current_commit.clone(),
        remote_commit: remote_commit.clone(),
        commits_behind,
        update_available: commits_behind > 0 || current_commit != remote_commit || channel_changed,
        has_prebuilt_asset: false,
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

fn copy_defaults_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| format!("Falha ao criar {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Falha ao ler {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_defaults_dir(&src_path, &dst_path)?;
        } else if !dst_path.exists() {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Falha ao copiar {}: {e}", src_path.display()))?;
        }
    }
    Ok(())
}

fn apply_github_release_update(check: &UpdateCheckResult) -> Result<UpdateApplyResult, String> {
    let tag = check
        .release_tag
        .as_deref()
        .ok_or_else(|| "Tag de release ausente".to_string())?;
    let repo = repo_slug();
    let tmp = tempfile::tempdir().map_err(|e| format!("Falha ao criar pasta temporária: {e}"))?;
    let mut log = format!("$ download {repo}@{tag}/{PREBUILT_ASSET_NAME}\n");
    download_release_asset(&repo, tag, PREBUILT_ASSET_NAME, None, tmp.path(), None)?;

    // Optional checksum verification if SHA256SUMS.txt is attached
    if download_release_asset(&repo, tag, "SHA256SUMS.txt", None, tmp.path(), None).is_ok()
        && tmp.path().join("SHA256SUMS.txt").exists()
    {
        let verify = Command::new("sha256sum")
            .args(["-c", "SHA256SUMS.txt"])
            .current_dir(tmp.path())
            .output();
        if let Ok(v) = verify {
            log.push_str("\n$ sha256sum -c SHA256SUMS.txt\n");
            log.push_str(&String::from_utf8_lossy(&v.stdout));
            log.push_str(&String::from_utf8_lossy(&v.stderr));
            if !v.status.success() {
                return Err(format!("Falha na verificação SHA-256:\n{log}"));
            }
        }
    }

    let extracted = tmp.path().join("extracted");
    fs::create_dir_all(&extracted).map_err(|e| format!("Falha ao criar pasta de extração: {e}"))?;
    let tar_out = Command::new("tar")
        .args([
            "-xzf",
            tmp.path().join(PREBUILT_ASSET_NAME).to_str().unwrap_or(""),
            "-C",
            extracted.to_str().unwrap_or(""),
        ])
        .output()
        .map_err(|e| format!("Falha ao extrair pacote: {e}"))?;
    if !tar_out.status.success() {
        return Err(format!(
            "tar falhou: {}",
            String::from_utf8_lossy(&tar_out.stderr)
        ));
    }

    let new_bin = extracted.join("game-hub");
    if !new_bin.exists() {
        return Err("Pacote da release não contém o binário 'game-hub'.".to_string());
    }

    let target_bin = bin_install_path()?;
    if let Some(parent) = target_bin.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Falha ao criar pasta bin: {e}"))?;
    }
    let staged_bin = target_bin.with_extension("new");
    fs::copy(&new_bin, &staged_bin)
        .map_err(|e| format!("Falha ao copiar novo binário: {e}"))?;
    fs::set_permissions(&staged_bin, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("Falha ao definir permissão executável: {e}"))?;
    fs::rename(&staged_bin, &target_bin)
        .map_err(|e| format!("Falha ao substituir binário em {}: {e}", target_bin.display()))?;

    if let Ok(cfg_dir) = config_dir() {
        let _ = copy_defaults_dir(&extracted.join("defaults"), &cfg_dir);
    }

    write_install_state(&InstallState {
        channel: check.channel.clone(),
        tag: Some(tag.to_string()),
        commit: check.remote_commit.clone(),
    });

    log.push_str(&format!(
        "\nInstalado binário pré-compilado em {}",
        target_bin.display()
    ));

    if !check.changelog.is_empty() {
        let mut header = format!(
            "=== Changelog ({} -> {}) ===\n",
            check.current_commit, check.remote_commit
        );
        for line in &check.changelog {
            header.push_str("  • ");
            header.push_str(line);
            header.push('\n');
        }
        header.push('\n');
        log = format!("{header}{log}");
    }

    Ok(UpdateApplyResult {
        channel: check.channel.clone(),
        source: "github-release".to_string(),
        updated: true,
        new_commit: check.remote_commit.clone(),
        release_tag: Some(tag.to_string()),
        message: format!(
            "Atualização ({} · {}) instalada via CI/CD ({}). Reinicie o Game Dev Hub.",
            check.channel, tag, check.remote_commit
        ),
        changelog: check.changelog.clone(),
        output_log: tail_chars(&log, 4000),
    })
}

/// Switches/pulls `origin/<channel-branch>` and rebuilds via `install.sh` if present.
pub fn apply_update_in_dir(repo_dir: &Path, channel: &str) -> Result<UpdateApplyResult, String> {
    let channel = normalize_channel(Some(channel));
    let old_commit = run_git(repo_dir, &["rev-parse", "--short", "HEAD"]).ok();
    let branch = detect_branch_for_channel(repo_dir, channel);
    run_git(repo_dir, &["fetch", "origin", &branch])?;

    let remote_ref = format!("origin/{branch}");
    let current_branch = run_git(repo_dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|_| String::new());

    let git_out = if current_branch == branch {
        run_git(repo_dir, &["pull", "--ff-only"])?
    } else {
        run_git(repo_dir, &["checkout", "-B", &branch, &remote_ref])?
    };

    let new_commit = run_git(repo_dir, &["rev-parse", "--short", "HEAD"])?;
    let changelog: Vec<String> = match old_commit.as_deref() {
        Some(old) if old != new_commit => {
            let range = format!("{old}..HEAD");
            run_git(repo_dir, &["log", "--no-merges", "--pretty=format:%h %s", "-n", "30", &range])
                .unwrap_or_default()
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(ToString::to_string)
                .collect()
        }
        _ => Vec::new(),
    };

    let mut combined_log = String::new();
    if !changelog.is_empty() {
        combined_log.push_str(&format!(
            "=== Changelog ({} -> {}) ===\n",
            old_commit.as_deref().unwrap_or("?"),
            new_commit
        ));
        for line in &changelog {
            combined_log.push_str("  • ");
            combined_log.push_str(line);
            combined_log.push('\n');
        }
        combined_log.push('\n');
    }
    combined_log.push_str(&format!("$ git channel {channel} ({remote_ref})\n{git_out}\n"));

    let install_sh = repo_dir.join("install.sh");
    if install_sh.exists() {
        let output = Command::new("bash")
            .arg(&install_sh)
            .args(["--from-source", "--channel", channel])
            .current_dir(repo_dir)
            .env("GAME_HUB_DIR", repo_dir)
            .env("GAME_HUB_CHANNEL", channel)
            .output()
            .map_err(|e| format!("Falha ao executar install.sh: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        combined_log.push_str("\n$ bash install.sh --from-source --channel ");
        combined_log.push_str(channel);
        combined_log.push('\n');
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
    write_install_state(&InstallState {
        channel: channel.to_string(),
        tag: None,
        commit: new_commit.clone(),
    });

    Ok(UpdateApplyResult {
        channel: channel.to_string(),
        source: "git-branch".to_string(),
        updated: true,
        new_commit: new_commit.clone(),
        release_tag: None,
        message: format!(
            "Atualização ({channel} · {new_commit}) aplicada. Reinicie o Game Dev Hub para usar a nova versão."
        ),
        changelog,
        output_log: tail_chars(&combined_log, 4000),
    })
}

pub fn check_for_updates(channel: Option<&str>) -> Result<UpdateCheckResult, String> {
    let channel = normalize_channel(channel);
    let ctx = CheckContext::start(UPDATE_CHECK_TOTAL_TIMEOUT);
    let repo_dir = resolve_install_repo_dir().ok();

    if let Some(release_check) =
        check_github_release_channel(channel, repo_dir.as_deref(), Some(&ctx))?
    {
        return Ok(release_check);
    }

    let dir = repo_dir.ok_or_else(|| {
        "Nenhuma release encontrada no GitHub e repositório local não encontrado (~/.local/share/game-hub).".to_string()
    })?;
    check_for_updates_in_dir_with_ctx(&dir, channel, Some(&ctx))
}

pub fn apply_update(channel: Option<&str>) -> Result<UpdateApplyResult, String> {
    let channel = normalize_channel(channel);
    let repo_dir = resolve_install_repo_dir().ok();

    if let Some(release_check) = check_github_release_channel(channel, repo_dir.as_deref(), None)? {
        if release_check.has_prebuilt_asset {
            return apply_github_release_update(&release_check);
        }
    }

    let dir = resolve_install_repo_dir()?;
    apply_update_in_dir(&dir, channel)
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn normalize_channel_defaults_to_stable() {
        assert_eq!(normalize_channel(None), "stable");
        assert_eq!(normalize_channel(Some("")), "stable");
        assert_eq!(normalize_channel(Some("stable")), "stable");
        assert_eq!(normalize_channel(Some("nightly")), "nightly");
        assert_eq!(normalize_channel(Some("NIGHTLY")), "nightly");
    }

    #[test]
    fn check_for_updates_detects_new_remote_commit_per_channel() {
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
        git(&seed_work, &["checkout", "-b", "stable"]);

        fs::write(seed_work.join("README.md"), "v1\n").unwrap();
        git(&seed_work, &["add", "."]);
        git(&seed_work, &["commit", "-m", "initial stable commit"]);
        git(&seed_work, &["push", "-u", "origin", "stable"]);

        // Create nightly branch ahead of stable
        git(&seed_work, &["checkout", "-b", "nightly"]);
        fs::write(seed_work.join("README.md"), "v2-nightly\n").unwrap();
        git(&seed_work, &["add", "."]);
        git(&seed_work, &["commit", "-m", "feat: bleeding edge nightly"]);
        git(&seed_work, &["push", "-u", "origin", "nightly"]);

        git(
            tmp.path(),
            &[
                "clone",
                "-b",
                "stable",
                bare_remote.to_str().unwrap(),
                local_clone.to_str().unwrap(),
            ],
        );

        let stable_check = check_for_updates_in_dir(&local_clone, "stable").unwrap();
        assert_eq!(stable_check.channel, "stable");
        assert_eq!(stable_check.branch, "stable");
        assert!(!stable_check.update_available);
        assert_eq!(stable_check.commits_behind, 0);

        let nightly_check = check_for_updates_in_dir(&local_clone, "nightly").unwrap();
        assert_eq!(nightly_check.channel, "nightly");
        assert_eq!(nightly_check.branch, "nightly");
        assert!(nightly_check.update_available);
        assert_eq!(nightly_check.commits_behind, 1);
        assert!(nightly_check.changelog[0].contains("bleeding edge nightly"));
    }

    #[test]
    fn run_command_with_timeout_aborts_stalled_process() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 5"]);
        let err = run_command_with_timeout(cmd, Duration::from_millis(120), None, "sleep-test")
            .expect_err("expected timeout error");
        assert!(err.contains("Tempo limite esgotado"));
    }

    #[test]
    fn run_command_with_timeout_cancels_on_signal() {
        let flag = Arc::new(AtomicBool::new(false));
        let flag_clone = Arc::clone(&flag);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            flag_clone.store(true, Ordering::SeqCst);
        });

        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 5"]);
        let err = run_command_with_timeout(
            cmd,
            Duration::from_secs(5),
            Some(flag.as_ref()),
            "cancel-test",
        )
        .expect_err("expected cancellation error");
        assert!(err.contains("cancelada"));
    }
}
