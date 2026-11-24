use crate::fs_watcher::EchoSuppressionCache;
use crate::sidecar::generate_session_token;
use crate::types::{
    FlowBridgeCallbackPayload, FlowGenerationResult, ImageGenerationConfig,
};
use crate::workspace::{canonicalize_in_workspace, config_dir, sha256_hex};
use base64::Engine as _;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

const EMBEDDED_FLOW_SCRIPT: &str = include_str!("../../defaults/bridges/flow.js");
const MIN_IMAGE_BYTES: usize = 64;
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024; // 25 MiB

static JOB_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize, Debug, Default)]
struct WorkspaceConfigFile {
    image_generation: Option<PartialImageGenerationConfig>,
}

#[derive(Deserialize, Debug, Default)]
struct PartialImageGenerationConfig {
    backend: Option<String>,
    flow_url: Option<String>,
    fallback_backend: Option<String>,
    gemini_model: Option<String>,
    timeout_secs: Option<u64>,
    webview_data_dir: Option<String>,
}

/// Abstracted Gemini API executor for deterministic unit testing and curl-based fallback.
pub trait GeminiApiExecutor: Send + Sync {
    fn generate_image(
        &self,
        api_key: &str,
        model: &str,
        prompt: &str,
        aspect_ratio: Option<&str>,
    ) -> Result<(Vec<u8>, String), String>;
}

/// Default `curl`-backed Gemini REST executor keeping `GEMINI_API_KEY` out of process `argv`.
pub struct DefaultCurlGeminiExecutor;

impl GeminiApiExecutor for DefaultCurlGeminiExecutor {
    fn generate_image(
        &self,
        api_key: &str,
        model: &str,
        prompt: &str,
        aspect_ratio: Option<&str>,
    ) -> Result<(Vec<u8>, String), String> {
        let endpoint = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        );
        let full_prompt = match aspect_ratio {
            Some(ar) if !ar.trim().is_empty() => format!("{prompt}\n\nAspect ratio: {ar}"),
            _ => prompt.to_string(),
        };

        let body = serde_json::json!({
            "contents": [{ "parts": [{ "text": full_prompt }] }],
            "generationConfig": { "responseModalities": ["IMAGE"] }
        });
        let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

        // Pass API key and JSON body via stdin so secrets never appear in `ps` / `/proc/<pid>/cmdline`.
        let curl_cfg = format!(
            "url = \"{endpoint}\"\nheader = \"Content-Type: application/json\"\nheader = \"x-goog-api-key: {}\"\n",
            api_key.replace('"', "")
        );

        let mut child = Command::new("curl")
            .args(["-sS", "--fail-with-body", "-X", "POST", "--config", "-", "--data-binary", "@-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn curl for gemini_api: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(curl_cfg.as_bytes())
                .and_then(|_| stdin.write_all(body_str.as_bytes()))
                .map_err(|e| format!("failed to write gemini_api request to curl stdin: {e}"))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("failed waiting for curl: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let out = String::from_utf8_lossy(&output.stdout);
            return Err(format!("gemini_api request failed: {err} {out}"));
        }

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("invalid gemini_api JSON response: {e}"))?;
        extract_gemini_image_from_json(&json)
    }
}

pub fn extract_gemini_image_from_json(json: &serde_json::Value) -> Result<(Vec<u8>, String), String> {
    let parts = json
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "gemini_api response missing candidates[0].content.parts".to_string())?;

    for part in parts {
        let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
        if let Some(obj) = inline {
            if let Some(b64) = obj.get("data").and_then(|v| v.as_str()) {
                let mime = obj
                    .get("mimeType")
                    .or_else(|| obj.get("mime_type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("image/png")
                    .to_string();
                let bytes = decode_base64_image(b64)?;
                return Ok((bytes, mime));
            }
        }
    }

    Err("gemini_api response did not include an image part".to_string())
}

/// Abstracted WebView driver so `FlowBridgeManager` remains 100% testable without GTK/WebKitGTK.
pub trait FlowBrowserDriver: Send + Sync {
    fn start_job(
        &self,
        job_id: &str,
        token: &str,
        flow_url: &str,
        profile_dir: &Path,
        script: &str,
        prompt: &str,
        aspect_ratio: Option<&str>,
        timeout_secs: u64,
        manager: Arc<FlowBridgeManager>,
    ) -> Result<(), String>;
}

pub struct PendingFlowJob {
    pub job_id: String,
    pub token: String,
    pub workspace_root: PathBuf,
    pub save_path: String,
    pub target_abs_path: PathBuf,
    pub backend_used: String,
    pub tx: oneshot::Sender<Result<FlowGenerationResult, String>>,
}

pub struct FlowBridgeManager {
    pending_jobs: Mutex<HashMap<String, PendingFlowJob>>,
    echo_cache: Arc<Mutex<EchoSuppressionCache>>,
    gemini_executor: Box<dyn GeminiApiExecutor>,
}

impl FlowBridgeManager {
    pub fn new(echo_cache: Arc<Mutex<EchoSuppressionCache>>) -> Self {
        Self::with_gemini_executor(echo_cache, Box::new(DefaultCurlGeminiExecutor))
    }

    pub fn with_gemini_executor(
        echo_cache: Arc<Mutex<EchoSuppressionCache>>,
        gemini_executor: Box<dyn GeminiApiExecutor>,
    ) -> Self {
        Self {
            pending_jobs: Mutex::new(HashMap::new()),
            echo_cache,
            gemini_executor,
        }
    }

    pub fn register_job(
        &self,
        workspace_root: &Path,
        save_path: &str,
        backend_used: &str,
    ) -> Result<
        (
            String,
            String,
            PathBuf,
            oneshot::Receiver<Result<FlowGenerationResult, String>>,
        ),
        String,
    > {
        let (rel_path, abs_path) = validate_and_prepare_save_path(workspace_root, save_path)?;
        let job_id = format!("flow-job-{}", JOB_COUNTER.fetch_add(1, Ordering::Relaxed));
        let token = generate_session_token();
        let (tx, rx) = oneshot::channel();

        let job = PendingFlowJob {
            job_id: job_id.clone(),
            token: token.clone(),
            workspace_root: workspace_root.to_path_buf(),
            save_path: rel_path,
            target_abs_path: abs_path.clone(),
            backend_used: backend_used.to_string(),
            tx,
        };

        let mut guard = self
            .pending_jobs
            .lock()
            .map_err(|_| "flow_bridge pending_jobs mutex poisoned".to_string())?;
        guard.insert(job_id.clone(), job);
        Ok((job_id, token, abs_path, rx))
    }

    pub fn cancel_job(&self, job_id: &str) {
        if let Ok(mut guard) = self.pending_jobs.lock() {
            guard.remove(job_id);
        }
    }

    pub fn resolve_job(
        &self,
        payload: FlowBridgeCallbackPayload,
        require_token: bool,
    ) -> Result<FlowGenerationResult, String> {
        let job = {
            let mut guard = self
                .pending_jobs
                .lock()
                .map_err(|_| "flow_bridge pending_jobs mutex poisoned".to_string())?;

            let existing = guard
                .get(&payload.job_id)
                .ok_or_else(|| format!("unknown or expired flow job: {}", payload.job_id))?;

            if require_token || payload.token.is_some() {
                let provided = payload.token.as_deref().unwrap_or("");
                if !constant_time_eq(provided.as_bytes(), existing.token.as_bytes()) {
                    return Err("invalid flow job token".to_string());
                }
            }

            guard.remove(&payload.job_id).unwrap()
        };

        if payload.status == "AUTH_REQUIRED" {
            let msg = format!(
                "AUTH_REQUIRED: {}",
                payload.error.unwrap_or_else(|| {
                    "Sessão Google não autenticada na janela do Flow. Faça login e tente novamente."
                        .to_string()
                })
            );
            let _ = job.tx.send(Err(msg.clone()));
            return Err(msg);
        }

        if payload.status != "OK" {
            let msg = payload
                .error
                .unwrap_or_else(|| format!("Flow bridge failed with status {}", payload.status));
            let _ = job.tx.send(Err(msg.clone()));
            return Err(msg);
        }

        let bytes = if let Some(b64) = payload.image_base64.as_deref() {
            decode_base64_image(b64)?
        } else if let Some(raw) = payload.image_bytes {
            raw
        } else {
            let msg = "Flow bridge callback missing image_base64/image_bytes".to_string();
            let _ = job.tx.send(Err(msg.clone()));
            return Err(msg);
        };

        let result = persist_validated_image(
            &job.job_id,
            &job.save_path,
            &job.target_abs_path,
            &job.backend_used,
            &bytes,
            &self.echo_cache,
        );

        match &result {
            Ok(ok_res) => {
                let _ = job.tx.send(Ok(ok_res.clone()));
            }
            Err(err_msg) => {
                let _ = job.tx.send(Err(err_msg.clone()));
            }
        }
        result
    }

    pub fn generate_via_gemini(
        &self,
        workspace_root: &Path,
        save_path: &str,
        cfg: &ImageGenerationConfig,
        prompt: &str,
        aspect_ratio: Option<&str>,
    ) -> Result<FlowGenerationResult, String> {
        let api_key = std::env::var("GEMINI_API_KEY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "GEMINI_API_KEY is not set for gemini_api fallback".to_string())?;

        let (rel_path, abs_path) = validate_and_prepare_save_path(workspace_root, save_path)?;
        let (bytes, _mime) =
            self.gemini_executor
                .generate_image(&api_key, &cfg.gemini_model, prompt, aspect_ratio)?;
        let job_id = format!("flow-gemini-{}", JOB_COUNTER.fetch_add(1, Ordering::Relaxed));
        persist_validated_image(&job_id, &rel_path, &abs_path, "gemini_api", &bytes, &self.echo_cache)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn decode_base64_image(raw: &str) -> Result<Vec<u8>, String> {
    let stripped = match raw.find(',') {
        Some(idx) if raw[..idx].starts_with("data:") => &raw[idx + 1..],
        _ => raw,
    };
    let clean: String = stripped.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(clean.as_bytes())
        .map_err(|e| format!("invalid base64 image payload: {e}"))
}

pub fn validate_image_magic_bytes(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() < MIN_IMAGE_BYTES {
        return Err(format!(
            "image payload too small ({} bytes < {MIN_IMAGE_BYTES})",
            bytes.len()
        ));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "image payload exceeds 25 MiB limit ({} bytes)",
            bytes.len()
        ));
    }

    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("png");
    }
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return Ok("jpeg");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok("webp");
    }

    Err("invalid image magic bytes (expected PNG, JPEG, or WebP)".to_string())
}

fn persist_validated_image(
    job_id: &str,
    rel_path: &str,
    abs_path: &Path,
    backend_used: &str,
    bytes: &[u8],
    echo_cache: &Arc<Mutex<EchoSuppressionCache>>,
) -> Result<FlowGenerationResult, String> {
    validate_image_magic_bytes(bytes)?;

    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent directory for {rel_path}: {e}"))?;
    }

    let tmp_path = abs_path.with_extension("tmp");
    fs::write(&tmp_path, bytes)
        .map_err(|e| format!("failed to write temporary image {rel_path}: {e}"))?;
    fs::rename(&tmp_path, abs_path)
        .map_err(|e| format!("failed to save image {rel_path}: {e}"))?;

    let sha256 = sha256_hex(bytes);
    if let Ok(mut cache) = echo_cache.lock() {
        cache.record_write(rel_path, sha256.clone());
    }

    let stem = Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("reference");

    Ok(FlowGenerationResult {
        job_id: job_id.to_string(),
        status: "OK".to_string(),
        saved_path: rel_path.to_string(),
        byte_size: bytes.len() as u64,
        sha256,
        markdown_embed: format!("![{stem}]({rel_path})"),
        obsidian_embed: format!("![[{rel_path}]]"),
        backend_used: backend_used.to_string(),
    })
}

/// Validates that `save_path` stays inside the workspace, avoids reserved files, and uses an image extension.
pub fn validate_and_prepare_save_path(
    workspace_root: &Path,
    save_path: &str,
) -> Result<(String, PathBuf), String> {
    let normalized = save_path
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string();

    if normalized.is_empty() {
        return Err("save_path must not be empty".to_string());
    }
    if normalized == ".git" || normalized.starts_with(".git/") {
        return Err("cannot write generated images inside .git/".to_string());
    }
    if matches!(
        normalized.as_str(),
        ".hub/hub.lock" | ".hub/project.json" | ".hub/layout.json" | ".hub/config.toml"
    ) {
        return Err(format!("cannot overwrite reserved hub file: {normalized}"));
    }

    let ext = Path::new(&normalized)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err(format!(
            "unsupported image extension for save_path '{normalized}' (expected .png, .jpg, .jpeg, or .webp)"
        ));
    }

    let abs = canonicalize_in_workspace(workspace_root, &normalized)?;
    Ok((normalized, abs))
}

/// Merges `<workspace>/.hub/config.toml` `[image_generation]` over the global config if present.
pub fn resolve_image_generation_config(
    workspace_root: &Path,
    global: &ImageGenerationConfig,
) -> ImageGenerationConfig {
    let mut merged = global.clone();
    let ws_cfg_path = workspace_root.join(".hub/config.toml");
    if let Ok(raw) = fs::read_to_string(ws_cfg_path) {
        if let Ok(parsed) = toml::from_str::<WorkspaceConfigFile>(&raw) {
            if let Some(ov) = parsed.image_generation {
                if let Some(b) = ov.backend {
                    merged.backend = b;
                }
                if let Some(u) = ov.flow_url {
                    merged.flow_url = u;
                }
                if let Some(fb) = ov.fallback_backend {
                    merged.fallback_backend = if fb.trim().is_empty() { None } else { Some(fb) };
                }
                if let Some(m) = ov.gemini_model {
                    merged.gemini_model = m;
                }
                if let Some(t) = ov.timeout_secs {
                    merged.timeout_secs = t;
                }
                if let Some(d) = ov.webview_data_dir {
                    merged.webview_data_dir = if d.trim().is_empty() { None } else { Some(d) };
                }
            }
        }
    }
    merged
}

/// Resolves the 3-tier `flow.js` bridge script:
/// 1. `<workspace>/.hub/bridges/flow.js`
/// 2. `~/.config/game-hub/bridges/flow.js`
/// 3. Embedded `defaults/bridges/flow.js`
pub fn resolve_flow_bridge_script(workspace_root: &Path) -> String {
    let ws_script = workspace_root.join(".hub/bridges/flow.js");
    if let Ok(raw) = fs::read_to_string(&ws_script) {
        if !raw.trim().is_empty() {
            return raw;
        }
    }

    if let Ok(cfg_dir) = config_dir() {
        let user_script = cfg_dir.join("bridges/flow.js");
        if let Ok(raw) = fs::read_to_string(&user_script) {
            if !raw.trim().is_empty() {
                return raw;
            }
        }
    }

    EMBEDDED_FLOW_SCRIPT.to_string()
}

/// Resolves persistent WebView profile dir (`~/.local/state/game-hub/webview-profile` with `0700`).
pub fn resolve_webview_profile_dir(cfg: &ImageGenerationConfig) -> Result<PathBuf, String> {
    let dir = if let Some(custom) = cfg.webview_data_dir.as_deref() {
        let trimmed = custom.trim();
        if let Some(rest) = trimmed.strip_prefix("~/") {
            let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
            PathBuf::from(home).join(rest)
        } else {
            PathBuf::from(trimmed)
        }
    } else if let Ok(xdg_state) = std::env::var("XDG_STATE_HOME") {
        if !xdg_state.trim().is_empty() {
            PathBuf::from(xdg_state.trim()).join("game-hub/webview-profile")
        } else {
            let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
            PathBuf::from(home).join(".local/state/game-hub/webview-profile")
        }
    } else {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        PathBuf::from(home).join(".local/state/game-hub/webview-profile")
    };

    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create webview profile dir {}: {e}", dir.display()))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("failed to set 0700 permissions on {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Host allowlist for the secondary `"flow-browser"` WebviewWindow.
pub fn is_allowed_flow_host(scheme: &str, host: &str, configured_host: &str) -> bool {
    let host_lc = host.to_ascii_lowercase();
    let cfg_lc = configured_host.to_ascii_lowercase();

    if scheme == "http" {
        return (host_lc == "127.0.0.1" || host_lc == "localhost") && host_lc == cfg_lc;
    }
    if scheme != "https" {
        return false;
    }

    host_lc == cfg_lc
        || host_lc == "labs.google"
        || host_lc == "accounts.google.com"
        || host_lc.ends_with(".google.com")
        || host_lc.ends_with(".googleusercontent.com")
        || host_lc.ends_with(".gstatic.com")
}

/// Orchestrates `dispatch_flow_generation` across `flow_browser` and `gemini_api` fallback.
pub async fn dispatch_flow_generation_with_driver<D: FlowBrowserDriver>(
    manager: Arc<FlowBridgeManager>,
    driver: &D,
    workspace_root: &Path,
    global_cfg: &ImageGenerationConfig,
    prompt: String,
    save_path: String,
    aspect_ratio: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<FlowGenerationResult, String> {
    if prompt.trim().is_empty() {
        return Err("prompt must not be empty".to_string());
    }

    let cfg = resolve_image_generation_config(workspace_root, global_cfg);
    let effective_timeout = timeout_secs.unwrap_or(cfg.timeout_secs).max(5);

    if cfg.backend == "gemini_api" {
        return manager.generate_via_gemini(
            workspace_root,
            &save_path,
            &cfg,
            &prompt,
            aspect_ratio.as_deref(),
        );
    }

    let (job_id, token, _abs_path, rx) =
        manager.register_job(workspace_root, &save_path, "flow_browser")?;
    let profile_dir = resolve_webview_profile_dir(&cfg)?;
    let script = resolve_flow_bridge_script(workspace_root);

    let start_res = driver.start_job(
        &job_id,
        &token,
        &cfg.flow_url,
        &profile_dir,
        &script,
        &prompt,
        aspect_ratio.as_deref(),
        effective_timeout,
        Arc::clone(&manager),
    );

    if let Err(err) = start_res {
        manager.cancel_job(&job_id);
        if cfg.fallback_backend.as_deref() == Some("gemini_api")
            && std::env::var("GEMINI_API_KEY")
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
        {
            return manager.generate_via_gemini(
                workspace_root,
                &save_path,
                &cfg,
                &prompt,
                aspect_ratio.as_deref(),
            );
        }
        return Err(err);
    }

    match tokio::time::timeout(Duration::from_secs(effective_timeout), rx).await {
        Ok(Ok(res)) => match res {
            Ok(ok) => Ok(ok),
            Err(err) => {
                if !err.starts_with("AUTH_REQUIRED")
                    && cfg.fallback_backend.as_deref() == Some("gemini_api")
                    && std::env::var("GEMINI_API_KEY")
                        .map(|v| !v.trim().is_empty())
                        .unwrap_or(false)
                {
                    return manager.generate_via_gemini(
                        workspace_root,
                        &save_path,
                        &cfg,
                        &prompt,
                        aspect_ratio.as_deref(),
                    );
                }
                Err(err)
            }
        },
        Ok(Err(_closed)) => Err("flow job channel closed unexpectedly".to_string()),
        Err(_elapsed) => {
            manager.cancel_job(&job_id);
            Err(format!(
                "timeout ({effective_timeout}s) waiting for Google Flow image generation"
            ))
        }
    }
}

#[cfg(feature = "desktop")]
pub mod desktop_driver {
    use super::*;
    use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    pub struct TauriWebviewFlowDriver {
        pub app: AppHandle,
    }

    pub fn open_or_focus_flow_window(
        app: &AppHandle,
        flow_url: &str,
        profile_dir: &Path,
        manager: Option<Arc<FlowBridgeManager>>,
    ) -> Result<WebviewWindow, String> {
        let parsed: tauri::Url = flow_url
            .parse()
            .map_err(|e| format!("invalid flow_url '{flow_url}': {e}"))?;
        let configured_host = parsed.host_str().unwrap_or("labs.google").to_string();

        if let Some(win) = app.get_webview_window("flow-browser") {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
            if let Ok(cur_url) = win.url() {
                let cur_host = cur_url.host_str().unwrap_or("");
                if cur_host != configured_host && cur_host != "accounts.google.com" {
                    let _ = win.navigate(parsed);
                }
            }
            return Ok(win);
        }

        let mut builder =
            WebviewWindowBuilder::new(app, "flow-browser", WebviewUrl::External(parsed))
                .title("Google Flow — Game Dev Hub")
                .inner_size(1280.0, 860.0)
                .visible(true)
                .focused(true)
                .data_directory(profile_dir.to_path_buf())
                .on_navigation(move |url| {
                    let scheme = url.scheme();
                    let host = url.host_str().unwrap_or("");
                    is_allowed_flow_host(scheme, host, &configured_host)
                });

        if let Some(mgr) = manager {
            builder = builder.on_document_title_changed(move |win, title| {
                if let Some(rest) = title.strip_prefix("[FLOW_BRIDGE:") {
                    if let Some((meta, _)) = rest.split_once(']') {
                        if let Some((job_id, _status)) = meta.split_once(':') {
                            harvest_flow_result(&win, job_id, Arc::clone(&mgr));
                        }
                    }
                }
            });
        }

        builder
            .build()
            .map_err(|e| format!("failed to open flow-browser window: {e}"))
    }

    fn harvest_flow_result(win: &WebviewWindow, job_id: &str, manager: Arc<FlowBridgeManager>) {
        let job_id_json = serde_json::to_string(job_id).unwrap_or_else(|_| "\"\"".to_string());
        let extract_js = format!(
            "(function(){{ var r = window.__FLOW_RESULTS__ && window.__FLOW_RESULTS__[{job_id_json}]; if (r) {{ delete window.__FLOW_RESULTS__[{job_id_json}]; return JSON.stringify(r); }} return null; }})()"
        );
        let _ = win.eval_with_callback(extract_js, move |raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed == "null" {
                return;
            }
            let payload = serde_json::from_str::<FlowBridgeCallbackPayload>(trimmed).or_else(|_| {
                let inner: String = serde_json::from_str(trimmed)?;
                serde_json::from_str::<FlowBridgeCallbackPayload>(&inner)
            });
            if let Ok(cb) = payload {
                let _ = manager.resolve_job(cb, true);
            }
        });
    }

    impl FlowBrowserDriver for TauriWebviewFlowDriver {
        fn start_job(
            &self,
            job_id: &str,
            token: &str,
            flow_url: &str,
            profile_dir: &Path,
            script: &str,
            prompt: &str,
            aspect_ratio: Option<&str>,
            timeout_secs: u64,
            manager: Arc<FlowBridgeManager>,
        ) -> Result<(), String> {
            let win = open_or_focus_flow_window(
                &self.app,
                flow_url,
                profile_dir,
                Some(Arc::clone(&manager)),
            )?;

            let job_payload = serde_json::json!({
                "job_id": job_id,
                "token": token,
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "timeout_ms": timeout_secs.saturating_mul(1000),
            });
            let inject_js = format!("window.__FLOW_JOB__ = {job_payload};\n{script}");
            let job_id_owned = job_id.to_string();

            tauri::async_runtime::spawn(async move {
                // Wait briefly for initial page document readiness before injecting flow.js
                for _ in 0..30 {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let tx_opt = Arc::new(Mutex::new(Some(tx)));
                    let tx_cb = Arc::clone(&tx_opt);
                    if win
                        .eval_with_callback(
                            "document.readyState",
                            move |state_str| {
                                if let Ok(mut g) = tx_cb.lock() {
                                    if let Some(sender) = g.take() {
                                        let _ = sender.send(state_str);
                                    }
                                }
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                    if let Ok(Ok(state_str)) =
                        tokio::time::timeout(Duration::from_millis(500), rx).await
                    {
                        if state_str.contains("complete") || state_str.contains("interactive") {
                            break;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }

                if let Err(e) = win.eval(inject_js) {
                    let _ = manager.resolve_job(
                        FlowBridgeCallbackPayload {
                            job_id: job_id_owned.clone(),
                            token: None,
                            status: "ERROR".to_string(),
                            image_base64: None,
                            image_bytes: None,
                            mime_type: None,
                            error: Some(format!("failed to inject flow.js: {e}")),
                        },
                        false,
                    );
                    return;
                }

                // Polling safety net alongside on_document_title_changed
                let polls = (timeout_secs * 1000 / 400).max(5);
                for _ in 0..polls {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    harvest_flow_result(&win, &job_id_owned, Arc::clone(&manager));
                }
            });

            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample_png_bytes() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        bytes.extend_from_slice(&[0u8; 80]);
        bytes
    }

    struct MockBrowserDriver;
    impl FlowBrowserDriver for MockBrowserDriver {
        fn start_job(
            &self,
            _job_id: &str,
            _token: &str,
            _flow_url: &str,
            _profile_dir: &Path,
            _script: &str,
            _prompt: &str,
            _aspect_ratio: Option<&str>,
            _timeout_secs: u64,
            _manager: Arc<FlowBridgeManager>,
        ) -> Result<(), String> {
            Err("browser unavailable in headless test".to_string())
        }
    }

    struct MockGeminiExecutor {
        png_bytes: Vec<u8>,
    }
    impl GeminiApiExecutor for MockGeminiExecutor {
        fn generate_image(
            &self,
            _api_key: &str,
            _model: &str,
            _prompt: &str,
            _aspect_ratio: Option<&str>,
        ) -> Result<(Vec<u8>, String), String> {
            Ok((self.png_bytes.clone(), "image/png".to_string()))
        }
    }

    #[test]
    fn blocks_path_traversal_and_non_image_extensions() {
        let dir = TempDir::new().unwrap();
        assert!(validate_and_prepare_save_path(dir.path(), "../escape.png").is_err());
        assert!(validate_and_prepare_save_path(dir.path(), "/etc/passwd").is_err());
        assert!(validate_and_prepare_save_path(dir.path(), ".hub/project.json").is_err());
        assert!(validate_and_prepare_save_path(dir.path(), "gdd/note.md").is_err());

        let (rel, abs) =
            validate_and_prepare_save_path(dir.path(), "world/personagens/img/ferreiro.png")
                .unwrap();
        assert_eq!(rel, "world/personagens/img/ferreiro.png");
        assert!(abs.starts_with(fs::canonicalize(dir.path()).unwrap()));
    }

    #[test]
    fn validates_magic_bytes_and_saves_png_on_ok_callback() {
        let dir = TempDir::new().unwrap();
        let echo_cache = Arc::new(Mutex::new(EchoSuppressionCache::default()));
        let manager = FlowBridgeManager::new(Arc::clone(&echo_cache));

        let (job_id, token, _abs, _rx) = manager
            .register_job(dir.path(), "world/personagens/img/ferreiro.png", "flow_browser")
            .unwrap();

        let png = sample_png_bytes();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);

        let res = manager
            .resolve_job(
                FlowBridgeCallbackPayload {
                    job_id,
                    token: Some(token),
                    status: "OK".to_string(),
                    image_base64: Some(format!("data:image/png;base64,{b64}")),
                    image_bytes: None,
                    mime_type: Some("image/png".to_string()),
                    error: None,
                },
                true,
            )
            .unwrap();

        assert_eq!(res.saved_path, "world/personagens/img/ferreiro.png");
        assert_eq!(res.markdown_embed, "![ferreiro](world/personagens/img/ferreiro.png)");
        assert_eq!(res.obsidian_embed, "![[world/personagens/img/ferreiro.png]]");
        assert!(dir.path().join("world/personagens/img/ferreiro.png").exists());
        assert!(echo_cache
            .lock()
            .unwrap()
            .should_suppress("world/personagens/img/ferreiro.png", &res.sha256));
    }

    #[test]
    fn propagates_auth_required_and_rejects_invalid_token() {
        let dir = TempDir::new().unwrap();
        let echo_cache = Arc::new(Mutex::new(EchoSuppressionCache::default()));
        let manager = FlowBridgeManager::new(echo_cache);

        let (job_id, token, _abs, _rx) = manager
            .register_job(dir.path(), "brainstorm/test.png", "flow_browser")
            .unwrap();

        let invalid = manager.resolve_job(
            FlowBridgeCallbackPayload {
                job_id: job_id.clone(),
                token: Some("wrong-token".to_string()),
                status: "OK".to_string(),
                image_base64: None,
                image_bytes: None,
                mime_type: None,
                error: None,
            },
            true,
        );
        assert!(invalid.is_err());

        let auth_err = manager.resolve_job(
            FlowBridgeCallbackPayload {
                job_id,
                token: Some(token),
                status: "AUTH_REQUIRED".to_string(),
                image_base64: None,
                image_bytes: None,
                mime_type: None,
                error: Some("Login needed".to_string()),
            },
            true,
        );
        assert!(auth_err.unwrap_err().starts_with("AUTH_REQUIRED:"));
    }

    #[tokio::test]
    async fn gemini_api_fallback_saves_image_when_browser_unavailable() {
        let dir = TempDir::new().unwrap();
        let echo_cache = Arc::new(Mutex::new(EchoSuppressionCache::default()));
        let manager = Arc::new(FlowBridgeManager::with_gemini_executor(
            echo_cache,
            Box::new(MockGeminiExecutor {
                png_bytes: sample_png_bytes(),
            }),
        ));

        let prev_key = std::env::var("GEMINI_API_KEY").ok();
        // SAFETY: isolated unit test setting GEMINI_API_KEY for fallback verification.
        unsafe {
            std::env::set_var("GEMINI_API_KEY", "test-gemini-key");
        }

        let res = dispatch_flow_generation_with_driver(
            manager,
            &MockBrowserDriver,
            dir.path(),
            &ImageGenerationConfig::default(),
            "A dwarven blacksmith forge".to_string(),
            "world/forja.png".to_string(),
            Some("16:9".to_string()),
            Some(10),
        )
        .await
        .unwrap();

        if let Some(old) = prev_key {
            unsafe { std::env::set_var("GEMINI_API_KEY", old) };
        } else {
            unsafe { std::env::remove_var("GEMINI_API_KEY") };
        }

        assert_eq!(res.backend_used, "gemini_api");
        assert!(dir.path().join("world/forja.png").exists());
    }

    #[test]
    fn workspace_config_toml_overrides_global_image_generation_config() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".hub/bridges")).unwrap();
        fs::write(
            dir.path().join(".hub/config.toml"),
            r#"
[image_generation]
backend = "gemini_api"
timeout_secs = 45
"#,
        )
        .unwrap();
        fs::write(
            dir.path().join(".hub/bridges/flow.js"),
            "// custom workspace flow bridge",
        )
        .unwrap();

        let merged = resolve_image_generation_config(dir.path(), &ImageGenerationConfig::default());
        assert_eq!(merged.backend, "gemini_api");
        assert_eq!(merged.timeout_secs, 45);
        assert_eq!(
            resolve_flow_bridge_script(dir.path()),
            "// custom workspace flow bridge"
        );
    }
}
