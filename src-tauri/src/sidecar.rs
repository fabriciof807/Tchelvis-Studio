use crate::fs_watcher::{format_epoch_ms_rfc3339, parse_loop_run_state};
use crate::types::{
    AmbientEnvelope, DispatchLoopOptions, LensInfo, LoopCheckResult, LoopRunState, LoopStage,
    LoopWorkflowInfo, PiAuthCheckResult, PiConfigureProviderRequest, PiProviderCatalogEntry,
    PiSetupStatus, PiToolCall, PiTurnAck,
};
use crate::workspace::{canonicalize_in_workspace, config_dir, current_socket_path, sha256_hex};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// Validates a provider slug against `^[a-z0-9-]+$` (1..=64 chars).
pub fn validate_provider_slug(provider: &str) -> Result<(), String> {
    if provider.is_empty() || provider.len() > 64 {
        return Err("provider must be 1..=64 characters".to_string());
    }
    if !provider
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(format!(
            "invalid provider '{provider}': must match ^[a-z0-9-]+$"
        ));
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
struct PiSetupRecord {
    first_run_completed: bool,
    mode: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    completed_at: Option<String>,
}

struct ProviderSeed {
    id: &'static str,
    label: &'static str,
    supports_api_key: bool,
    supports_oauth: bool,
    env_var_hint: Option<&'static str>,
    suggested_models: &'static [&'static str],
}

const CURATED_PROVIDERS: &[ProviderSeed] = &[
    ProviderSeed {
        id: "opencode-go",
        label: "OpenCode Go",
        supports_api_key: true,
        supports_oauth: true,
        env_var_hint: Some("OPENCODE_API_KEY"),
        suggested_models: &["deepseek-v4.1-flash", "hy4-flash-free", "claude-haiku-5-5"],
    },
    ProviderSeed {
        id: "openrouter",
        label: "OpenRouter",
        supports_api_key: true,
        supports_oauth: true,
        env_var_hint: Some("OPENROUTER_API_KEY"),
        suggested_models: &[
            "anthropic/claude-sonnet-4.5",
            "deepseek/deepseek-chat",
            "google/gemini-2.5-flash",
        ],
    },
    ProviderSeed {
        id: "anthropic",
        label: "Anthropic (Claude)",
        supports_api_key: true,
        supports_oauth: true,
        env_var_hint: Some("ANTHROPIC_API_KEY"),
        suggested_models: &["claude-sonnet-4-5", "claude-haiku-5-5"],
    },
    ProviderSeed {
        id: "openai",
        label: "OpenAI",
        supports_api_key: true,
        supports_oauth: false,
        env_var_hint: Some("OPENAI_API_KEY"),
        suggested_models: &["gpt-5", "gpt-4.1", "gpt-4.1-mini"],
    },
    ProviderSeed {
        id: "openai-codex",
        label: "OpenAI Codex (ChatGPT OAuth)",
        supports_api_key: false,
        supports_oauth: true,
        env_var_hint: None,
        suggested_models: &["codex-mini-latest", "gpt-5-codex"],
    },
    ProviderSeed {
        id: "google",
        label: "Google Gemini",
        supports_api_key: true,
        supports_oauth: true,
        env_var_hint: Some("GEMINI_API_KEY"),
        suggested_models: &["gemini-2.5-pro", "gemini-2.5-flash"],
    },
    ProviderSeed {
        id: "deepseek",
        label: "DeepSeek",
        supports_api_key: true,
        supports_oauth: false,
        env_var_hint: Some("DEEPSEEK_API_KEY"),
        suggested_models: &["deepseek-chat", "deepseek-reasoner"],
    },
    ProviderSeed {
        id: "groq",
        label: "Groq",
        supports_api_key: true,
        supports_oauth: false,
        env_var_hint: Some("GROQ_API_KEY"),
        suggested_models: &["llama-3.3-70b-versatile", "qwen-qwq-32b"],
    },
    ProviderSeed {
        id: "xai",
        label: "xAI (Grok)",
        supports_api_key: true,
        supports_oauth: false,
        env_var_hint: Some("XAI_API_KEY"),
        suggested_models: &["grok-3", "grok-3-mini"],
    },
    ProviderSeed {
        id: "github-copilot",
        label: "GitHub Copilot",
        supports_api_key: false,
        supports_oauth: true,
        env_var_hint: None,
        suggested_models: &["claude-sonnet-4", "gpt-4.1"],
    },
    ProviderSeed {
        id: "mistral",
        label: "Mistral AI",
        supports_api_key: true,
        supports_oauth: false,
        env_var_hint: Some("MISTRAL_API_KEY"),
        suggested_models: &["mistral-large-latest", "codestral-latest"],
    },
    ProviderSeed {
        id: "cerebras",
        label: "Cerebras",
        supports_api_key: true,
        supports_oauth: false,
        env_var_hint: Some("CEREBRAS_API_KEY"),
        suggested_models: &["llama-3.3-70b"],
    },
];

/// Returns the curated catalog of Pi Durable providers.
pub fn providers_catalog() -> Vec<PiProviderCatalogEntry> {
    CURATED_PROVIDERS
        .iter()
        .map(|seed| PiProviderCatalogEntry {
            id: seed.id.to_string(),
            label: seed.label.to_string(),
            supports_api_key: seed.supports_api_key,
            supports_oauth: seed.supports_oauth,
            configured: false,
            auth_type: None,
            env_var_hint: seed.env_var_hint.map(|s| s.to_string()),
            suggested_models: seed
                .suggested_models
                .iter()
                .map(|m| (*m).to_string())
                .collect(),
        })
        .collect()
}

fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("failed to create dir {}: {e}", dir.display()))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("failed to set dir permissions {}: {e}", dir.display()))?;
    Ok(())
}

fn write_json_atomic(path: &Path, value: &serde_json::Value, mode: u32) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent dir {}: {e}", parent.display()))?;
    }
    let tmp_name = format!(
        "{}.tmp.{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file.json"),
        std::process::id()
    );
    let tmp_path = path.with_file_name(tmp_name);
    let serialized =
        serde_json::to_string_pretty(value).map_err(|e| format!("json serialize error: {e}"))?;
    {
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("failed to create temp file {}: {e}", tmp_path.display()))?;
        f.write_all(serialized.as_bytes())
            .map_err(|e| format!("failed to write temp file {}: {e}", tmp_path.display()))?;
        f.write_all(b"\n")
            .map_err(|e| format!("failed to write newline {}: {e}", tmp_path.display()))?;
    }
    fs::set_permissions(&tmp_path, fs::Permissions::from_mode(mode))
        .map_err(|e| format!("failed to set permissions {}: {e}", tmp_path.display()))?;
    fs::rename(&tmp_path, path)
        .map_err(|e| format!("failed to rename {} -> {}: {e}", tmp_path.display(), path.display()))?;
    Ok(())
}

fn read_json_map(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Reads ONLY top-level provider keys and their `"type"` field from `auth.json`.
/// Never copies or serializes secret values (`"key"`, `"access"`, `"refresh"`).
fn read_configured_auth_types(pi_agent_dir: &Path) -> BTreeMap<String, Option<String>> {
    let mut out = BTreeMap::new();
    let map = read_json_map(&pi_agent_dir.join("auth.json"));
    for (provider, val) in map {
        if let Some(obj) = val.as_object() {
            if !obj.is_empty() {
                let auth_type = obj
                    .get("type")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                out.insert(provider, auth_type);
            }
        }
    }
    out
}

fn read_pi_settings_defaults(pi_agent_dir: &Path) -> (Option<String>, Option<String>) {
    let map = read_json_map(&pi_agent_dir.join("settings.json"));
    let provider = map
        .get("defaultProvider")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let model = map
        .get("defaultModel")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    (provider, model)
}

fn read_pi_setup_record(hub_config_dir: &Path) -> PiSetupRecord {
    fs::read_to_string(hub_config_dir.join("pi_setup.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<PiSetupRecord>(&raw).ok())
        .unwrap_or_default()
}

fn collect_models_from_store(pi_agent_dir: &Path, provider: &str) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(pi_agent_dir.join("models-store.json")) else {
        return Vec::new();
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let mut models = Vec::new();
    let push_entry = |entry: &serde_json::Value, out: &mut Vec<String>| {
        if let Some(s) = entry.as_str() {
            if !s.trim().is_empty() {
                out.push(s.trim().to_string());
            }
        } else if let Some(obj) = entry.as_object() {
            if let Some(id) = obj.get("id").and_then(|v| v.as_str()) {
                if !id.trim().is_empty() {
                    out.push(id.trim().to_string());
                }
            }
        }
    };
    if let Some(obj) = val.as_object() {
        if let Some(arr) = obj.get(provider).and_then(|v| v.as_array()) {
            for item in arr {
                push_entry(item, &mut models);
            }
        }
        if let Some(arr) = obj.get("models").and_then(|v| v.as_array()) {
            for item in arr {
                if item
                    .as_object()
                    .and_then(|m| m.get("provider"))
                    .and_then(|v| v.as_str())
                    == Some(provider)
                {
                    push_entry(item, &mut models);
                }
            }
        }
    }
    models
}

fn run_command_capture_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<(std::process::ExitStatus, String, String), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn command: {e}"))?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_handle = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(ref mut r) = stdout_pipe {
            let _ = r.read_to_string(&mut buf);
        }
        buf
    });
    let stderr_handle = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(ref mut r) = stderr_pipe {
            let _ = r.read_to_string(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("command timed out after {}s", timeout.as_secs()));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("failed waiting for command: {e}")),
        }
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    Ok((status, stdout, stderr))
}

/// Runs `pi auth check --provider <provider> --no-refresh --json` with a 5s timeout.
pub fn check_pi_provider_auth(
    pi_bin: &Path,
    pi_agent_dir: &Path,
    provider: &str,
) -> Result<PiAuthCheckResult, String> {
    validate_provider_slug(provider)?;
    let mut cmd = Command::new(pi_bin);
    cmd.args(["auth", "check", "--provider", provider, "--no-refresh", "--json"])
        .env("PI_CODING_AGENT_DIR", pi_agent_dir);

    let (_status, stdout, stderr) = run_command_capture_with_timeout(&mut cmd, Duration::from_secs(5))?;
    let trimmed = stdout.trim();
    let json_line = trimmed.lines().rev().find(|l| l.trim_start().starts_with('{'));
    let Some(raw) = json_line else {
        return Err(format!(
            "pi auth check returned non-json output: {}",
            stderr.trim()
        ));
    };
    let val: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid pi auth check JSON: {e}"))?;
    Ok(PiAuthCheckResult {
        status: val
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("not_ready")
            .to_string(),
        provider: val
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or(provider)
            .to_string(),
        auth_type: val
            .get("authType")
            .or_else(|| val.get("auth_type"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        reason: val
            .get("reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// Computes `PiSetupStatus` using explicit `pi_bin`, `pi_agent_dir`, and `hub_config_dir`.
pub fn get_pi_setup_status_in(
    pi_bin_override: Option<&Path>,
    pi_agent_dir: &Path,
    hub_config_dir: &Path,
) -> Result<PiSetupStatus, String> {
    let setup_rec = read_pi_setup_record(hub_config_dir);
    let (settings_provider, settings_model) = read_pi_settings_defaults(pi_agent_dir);
    let auth_types = read_configured_auth_types(pi_agent_dir);
    let configured_providers: Vec<String> = auth_types.keys().cloned().collect();

    let mut providers = providers_catalog();
    let mut known_ids = HashSet::new();
    for entry in &mut providers {
        known_ids.insert(entry.id.clone());
        if let Some(auth_type) = auth_types.get(&entry.id) {
            entry.configured = true;
            entry.auth_type = auth_type.clone();
        }
    }
    for (extra_id, auth_type) in &auth_types {
        if !known_ids.contains(extra_id) {
            providers.push(PiProviderCatalogEntry {
                id: extra_id.clone(),
                label: extra_id.clone(),
                supports_api_key: true,
                supports_oauth: true,
                configured: true,
                auth_type: auth_type.clone(),
                env_var_hint: None,
                suggested_models: Vec::new(),
            });
        }
    }

    let active_provider = settings_provider
        .or_else(|| setup_rec.provider.clone())
        .or_else(|| configured_providers.first().cloned());

    let active_model = settings_model
        .or_else(|| setup_rec.model.clone())
        .or_else(|| {
            active_provider.as_ref().and_then(|p| {
                providers
                    .iter()
                    .find(|entry| &entry.id == p)
                    .and_then(|entry| entry.suggested_models.first().cloned())
            })
        });

    let provider_ready = match active_provider.as_deref() {
        Some(p) => {
            if let Some(bin) = pi_bin_override {
                match check_pi_provider_auth(bin, pi_agent_dir, p) {
                    Ok(res) => res.status == "ready",
                    Err(_) => auth_types.contains_key(p),
                }
            } else {
                auth_types.contains_key(p)
            }
        }
        None => false,
    };

    let mut available_models = Vec::new();
    let mut seen_models = HashSet::new();
    if let Some(ref p) = active_provider {
        for m in collect_models_from_store(pi_agent_dir, p) {
            if seen_models.insert(m.clone()) {
                available_models.push(m);
            }
        }
        if let Some(entry) = providers.iter().find(|e| &e.id == p) {
            for m in &entry.suggested_models {
                if seen_models.insert(m.clone()) {
                    available_models.push(m.clone());
                }
            }
        }
    }

    let first_run_completed = setup_rec.first_run_completed;
    let needs_setup = if first_run_completed && setup_rec.mode.as_deref() == Some("offline") {
        false
    } else {
        !first_run_completed || !provider_ready
    };

    Ok(PiSetupStatus {
        pi_available: pi_bin_override.is_some(),
        pi_bin: pi_bin_override.map(|p| p.to_string_lossy().to_string()),
        first_run_completed,
        needs_setup,
        active_provider,
        active_model,
        provider_ready,
        configured_providers,
        providers,
        available_models,
    })
}

/// Configures a Pi provider (API key, defaultProvider/defaultModel, or offline mode) in isolated dirs.
pub fn configure_pi_provider_in(
    pi_bin_override: Option<&Path>,
    pi_agent_dir: &Path,
    hub_config_dir: &Path,
    req: &PiConfigureProviderRequest,
) -> Result<PiSetupStatus, String> {
    let provider = req.provider.trim();
    let now_iso = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format_epoch_ms_rfc3339(d.as_millis() as u64))
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());

    if provider == "offline" && req.mark_completed {
        let rec = serde_json::json!({
            "first_run_completed": true,
            "mode": "offline",
            "provider": serde_json::Value::Null,
            "model": serde_json::Value::Null,
            "completed_at": now_iso,
        });
        write_json_atomic(&hub_config_dir.join("pi_setup.json"), &rec, 0o600)?;
        return get_pi_setup_status_in(pi_bin_override, pi_agent_dir, hub_config_dir);
    }

    validate_provider_slug(provider)?;

    if let Some(ref raw_key) = req.api_key {
        let trimmed_key = raw_key.trim();
        if !trimmed_key.is_empty() {
            ensure_private_dir(pi_agent_dir)?;
            let auth_path = pi_agent_dir.join("auth.json");
            let mut auth_map = read_json_map(&auth_path);
            auth_map.insert(
                provider.to_string(),
                serde_json::json!({
                    "type": "api_key",
                    "key": trimmed_key,
                }),
            );
            write_json_atomic(&auth_path, &serde_json::Value::Object(auth_map), 0o600)?;
        }
    }

    ensure_private_dir(pi_agent_dir)?;
    let settings_path = pi_agent_dir.join("settings.json");
    let mut settings_map = read_json_map(&settings_path);
    settings_map.insert(
        "defaultProvider".to_string(),
        serde_json::Value::String(provider.to_string()),
    );
    let trimmed_model = req
        .model
        .as_deref()
        .map(|m| m.trim())
        .filter(|m| !m.is_empty())
        .map(|m| m.to_string());
    if let Some(ref m) = trimmed_model {
        settings_map.insert(
            "defaultModel".to_string(),
            serde_json::Value::String(m.clone()),
        );
    }
    write_json_atomic(
        &settings_path,
        &serde_json::Value::Object(settings_map),
        0o600,
    )?;

    if req.mark_completed {
        let rec = serde_json::json!({
            "first_run_completed": true,
            "mode": "pi",
            "provider": provider,
            "model": trimmed_model,
            "completed_at": now_iso,
        });
        write_json_atomic(&hub_config_dir.join("pi_setup.json"), &rec, 0o600)?;
    }

    get_pi_setup_status_in(pi_bin_override, pi_agent_dir, hub_config_dir)
}

/// Removes a provider's credentials from `auth.json` atomically.
pub fn logout_pi_provider_in(
    pi_bin_override: Option<&Path>,
    pi_agent_dir: &Path,
    hub_config_dir: &Path,
    provider: &str,
) -> Result<PiSetupStatus, String> {
    let provider = provider.trim();
    validate_provider_slug(provider)?;
    let auth_path = pi_agent_dir.join("auth.json");
    if auth_path.exists() {
        let mut auth_map = read_json_map(&auth_path);
        auth_map.remove(provider);
        write_json_atomic(&auth_path, &serde_json::Value::Object(auth_map), 0o600)?;
    }
    get_pi_setup_status_in(pi_bin_override, pi_agent_dir, hub_config_dir)
}

/// Convenience wrapper using default `~/.pi/agent` and `~/.config/game-hub`.
pub fn get_pi_setup_status(bin_name: &str) -> Result<PiSetupStatus, String> {
    let pi_bin = resolve_pi_binary(bin_name);
    let pi_agent_dir = default_pi_agent_dir()?;
    let hub_config_dir = config_dir()?;
    get_pi_setup_status_in(pi_bin.as_deref(), &pi_agent_dir, &hub_config_dir)
}

/// Convenience wrapper for `pi auth check` using default `~/.pi/agent`.
pub fn check_pi_provider(bin_name: &str, provider: &str) -> Result<PiAuthCheckResult, String> {
    let pi_bin = resolve_pi_binary(bin_name)
        .ok_or_else(|| format!("Pi CLI binary '{bin_name}' not found in $PATH"))?;
    let pi_agent_dir = default_pi_agent_dir()?;
    check_pi_provider_auth(&pi_bin, &pi_agent_dir, provider)
}

/// Convenience wrapper for configuring a Pi provider in default dirs.
pub fn configure_pi_provider(
    bin_name: &str,
    req: &PiConfigureProviderRequest,
) -> Result<PiSetupStatus, String> {
    let pi_bin = resolve_pi_binary(bin_name);
    let pi_agent_dir = default_pi_agent_dir()?;
    let hub_config_dir = config_dir()?;
    configure_pi_provider_in(pi_bin.as_deref(), &pi_agent_dir, &hub_config_dir, req)
}

/// Convenience wrapper for logging out a Pi provider in default dirs.
pub fn logout_pi_provider(bin_name: &str, provider: &str) -> Result<PiSetupStatus, String> {
    let pi_bin = resolve_pi_binary(bin_name);
    let pi_agent_dir = default_pi_agent_dir()?;
    let hub_config_dir = config_dir()?;
    logout_pi_provider_in(pi_bin.as_deref(), &pi_agent_dir, &hub_config_dir, provider)
}

/// Validates a lens slug against `^[a-z0-9-]+$`.
pub fn validate_lens_slug(lens_id: &str) -> Result<(), String> {
    if lens_id.is_empty() {
        return Err("lens_id must not be empty".to_string());
    }
    if !lens_id
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(format!(
            "invalid lens_id '{lens_id}': must match ^[a-z0-9-]+$"
        ));
    }
    Ok(())
}

/// Converts an arbitrary title into a safe `[a-z0-9-]+` slug.
pub fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in input.chars() {
        let lc = ch.to_ascii_lowercase();
        if lc.is_ascii_alphanumeric() {
            out.push(lc);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

/// Publishes a read-only HTML lens to `.hub/views/<lens_id>.html`.
pub fn publish_lens(
    workspace_root: &Path,
    lens_id: &str,
    title: &str,
    html_content: &str,
) -> Result<LensInfo, String> {
    validate_lens_slug(lens_id)?;
    let rel_path = format!(".hub/views/{lens_id}.html");
    let abs = canonicalize_in_workspace(workspace_root, &rel_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create .hub/views: {e}"))?;
    }
    let meta_comment = format!("<!-- hub-lens-title: {} -->\n", title.replace("-->", ""));
    let final_html = if html_content.trim_start().starts_with("<!-- hub-lens-title:") {
        html_content.to_string()
    } else {
        format!("{meta_comment}{html_content}")
    };
    fs::write(&abs, final_html.as_bytes())
        .map_err(|e| format!("failed to write lens {lens_id}: {e}"))?;

    Ok(LensInfo {
        lens_id: lens_id.to_string(),
        title: title.to_string(),
        rel_path,
    })
}

/// Lists all lenses in `.hub/views/*.html`.
pub fn list_lenses(workspace_root: &Path) -> Result<Vec<LensInfo>, String> {
    let views_dir = workspace_root.join(".hub/views");
    if !views_dir.exists() {
        return Ok(Vec::new());
    }
    let mut lenses = Vec::new();
    for entry in fs::read_dir(&views_dir).map_err(|e| format!("failed to read .hub/views: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("html") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_lens_slug(stem).is_err() {
            continue;
        }
        let content = fs::read_to_string(&path).unwrap_or_default();
        let title = extract_lens_title(&content).unwrap_or_else(|| stem.to_string());
        lenses.push(LensInfo {
            lens_id: stem.to_string(),
            title,
            rel_path: format!(".hub/views/{stem}.html"),
        });
    }
    lenses.sort_by(|a, b| a.lens_id.cmp(&b.lens_id));
    Ok(lenses)
}

fn extract_lens_title(html: &str) -> Option<String> {
    let prefix = "<!-- hub-lens-title:";
    let first_line = html.lines().next()?.trim();
    if let Some(rest) = first_line.strip_prefix(prefix) {
        if let Some(title) = rest.strip_suffix("-->") {
            let trimmed = title.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Reads the HTML contents of a published lens.
pub fn read_lens_html(workspace_root: &Path, lens_id: &str) -> Result<String, String> {
    validate_lens_slug(lens_id)?;
    let rel_path = format!(".hub/views/{lens_id}.html");
    let abs = canonicalize_in_workspace(workspace_root, &rel_path)?;
    fs::read_to_string(&abs).map_err(|e| format!("failed to read lens {lens_id}: {e}"))
}

/// Tool schema exposed to `dpi-backend` for generating visual references via Google Flow.
pub fn flow_tool_definition() -> serde_json::Value {
    serde_json::json!({
        "name": "generate_flow_reference",
        "description": "Generates a reference image via Google Flow (or configured Gemini image fallback) and saves it directly inside the active workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Detailed visual description in English."
                },
                "save_path": {
                    "type": "string",
                    "description": "Workspace-relative image path (e.g. world/personagens/img/ferreiro.png)."
                },
                "aspect_ratio": {
                    "type": "string",
                    "enum": ["16:9", "1:1", "3:4", "4:3", "9:16"],
                    "description": "Optional image aspect ratio."
                }
            },
            "required": ["prompt", "save_path"]
        }
    })
}

/// Tool schema exposed to `dpi-backend` for dispatching autonomous `tchelvis loop` runs.
pub fn loop_tool_definition() -> serde_json::Value {
    serde_json::json!({
        "name": "dispatch_tchelvis_loop",
        "description": "Dispatches an autonomous multi-agent `tchelvis loop` workflow in the active workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow": {
                    "type": "string",
                    "description": "Workflow name (e.g. fast-worker-reviewer, designer-worker-reviewer)."
                },
                "title": {
                    "type": "string",
                    "description": "Short descriptive title for the loop task."
                },
                "spec_markdown": {
                    "type": "string",
                    "description": "Task specification / prompt in Markdown."
                },
                "max_cycles": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20,
                    "description": "Optional max loop cycles (1..=20)."
                },
                "from_head": {
                    "type": "boolean",
                    "description": "Start from HEAD even if the workspace has uncommitted changes."
                },
                "use_overrides": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional stage model overrides formatted as stage=cli:model."
                }
            },
            "required": ["workflow", "title", "spec_markdown"]
        }
    })
}

/// Adapter boundary for `Pi Durable` (`dpi-backend`).
pub trait PiSidecarAdapter: Send {
    fn mode(&self) -> &'static str;
    fn send_message(
        &mut self,
        workspace_root: &Path,
        envelope: &AmbientEnvelope,
    ) -> Result<PiTurnAck, String>;
    fn shutdown(&mut self);
}

/// Offline fallback used when `dpi-backend` is not present in `$PATH`.
#[derive(Debug, Default)]
pub struct OfflinePiAdapter;

impl PiSidecarAdapter for OfflinePiAdapter {
    fn mode(&self) -> &'static str {
        "offline"
    }

    fn send_message(
        &mut self,
        _workspace_root: &Path,
        envelope: &AmbientEnvelope,
    ) -> Result<PiTurnAck, String> {
        let turn_id = format!("turn-{}", TURN_COUNTER.fetch_add(1, Ordering::Relaxed));
        let reply_text = format!(
            "[Chat offline fallback: `dpi-backend` not found in $PATH] Received message ({} chars) with focused_panel='{}', {} dirty file(s), {} one-shot attachment(s).",
            envelope.user_message.len(),
            envelope.active_context.focused_panel,
            envelope.active_context.dirty_files.len(),
            envelope.one_shot_attachments.len()
        );
        Ok(PiTurnAck {
            turn_id,
            mode: "offline".to_string(),
            reply_text,
            tool_calls: Vec::new(),
        })
    }

    fn shutdown(&mut self) {}
}

/// Subprocess-backed adapter for Pi Durable (`pi`) running in its own process group.
pub struct ProcessPiAdapter {
    bin_path: PathBuf,
    pi_agent_dir_override: Option<PathBuf>,
    child: Option<Child>,
}

impl ProcessPiAdapter {
    pub fn new(bin_path: PathBuf) -> Self {
        Self {
            bin_path,
            pi_agent_dir_override: None,
            child: None,
        }
    }

    pub fn with_agent_dir(bin_path: PathBuf, pi_agent_dir: PathBuf) -> Self {
        Self {
            bin_path,
            pi_agent_dir_override: Some(pi_agent_dir),
            child: None,
        }
    }

    fn build_contextualized_prompt(envelope: &AmbientEnvelope) -> String {
        let mut ctx_lines = Vec::new();
        ctx_lines.push(format!("focused_panel: {}", envelope.active_context.focused_panel));
        if !envelope.active_context.open_tabs.is_empty() {
            ctx_lines.push(format!(
                "open_tabs: {}",
                envelope.active_context.open_tabs.join(", ")
            ));
        }
        if !envelope.active_context.dirty_files.is_empty() {
            ctx_lines.push(format!(
                "dirty_files: {}",
                envelope.active_context.dirty_files.join(", ")
            ));
        }
        if let Some(ref loop_ref) = envelope.active_context.latest_loop {
            ctx_lines.push(format!(
                "latest_loop: {} ({})",
                loop_ref.run_id, loop_ref.status
            ));
        }
        for att in &envelope.one_shot_attachments {
            let note = att.user_note.as_deref().unwrap_or("");
            if note.is_empty() {
                ctx_lines.push(format!("attachment: {} ({})", att.image_path, att.r#type));
            } else {
                ctx_lines.push(format!(
                    "attachment: {} ({}) — {}",
                    att.image_path, att.r#type, note
                ));
            }
        }
        format!(
            "[Hub Context]\n{}\n\n{}",
            ctx_lines.join("\n"),
            envelope.user_message
        )
    }

    fn parse_pi_jsonl_output(stdout: &str) -> Result<(String, Vec<PiToolCall>), String> {
        let mut streamed_text = String::new();
        let mut final_text = String::new();
        let mut tool_calls: Vec<PiToolCall> = Vec::new();

        for line in stdout.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with('{') {
                continue;
            }
            let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            let ev_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match ev_type {
                "message_update" => {
                    if let Some(ame) = val.get("assistantMessageEvent").and_then(|v| v.as_object())
                    {
                        let ame_type = ame.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if ame_type == "text_delta" {
                            if let Some(delta) = ame.get("delta").and_then(|v| v.as_str()) {
                                streamed_text.push_str(delta);
                            }
                        } else if ame_type == "toolcall_start" {
                            let id = ame
                                .get("id")
                                .or_else(|| ame.get("toolCallId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool-0")
                                .to_string();
                            let name = ame
                                .get("name")
                                .or_else(|| ame.get("toolName"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            if !tool_calls.iter().any(|t| t.id == id) {
                                tool_calls.push(PiToolCall {
                                    id,
                                    name,
                                    arguments_json: "{}".to_string(),
                                    result_json: None,
                                    status: "running".to_string(),
                                });
                            }
                        }
                    }
                }
                "tool_execution_start" => {
                    let id = val
                        .get("toolCallId")
                        .or_else(|| val.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool-0")
                        .to_string();
                    let name = val
                        .get("toolName")
                        .or_else(|| val.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let arguments_json = val
                        .get("args")
                        .or_else(|| val.get("arguments"))
                        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string()))
                        .unwrap_or_else(|| "{}".to_string());
                    if let Some(existing) = tool_calls.iter_mut().find(|t| t.id == id) {
                        existing.name = name;
                        existing.arguments_json = arguments_json;
                        existing.status = "running".to_string();
                    } else {
                        tool_calls.push(PiToolCall {
                            id,
                            name,
                            arguments_json,
                            result_json: None,
                            status: "running".to_string(),
                        });
                    }
                }
                "tool_execution_end" => {
                    let id = val
                        .get("toolCallId")
                        .or_else(|| val.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool-0")
                        .to_string();
                    let is_error = val
                        .get("isError")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let result_json = val
                        .get("result")
                        .map(|v| serde_json::to_string(v).unwrap_or_default());
                    let status = if is_error { "error" } else { "completed" }.to_string();
                    if let Some(existing) = tool_calls.iter_mut().find(|t| t.id == id) {
                        existing.result_json = result_json;
                        existing.status = status;
                    } else {
                        let name = val
                            .get("toolName")
                            .or_else(|| val.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool")
                            .to_string();
                        tool_calls.push(PiToolCall {
                            id,
                            name,
                            arguments_json: "{}".to_string(),
                            result_json,
                            status,
                        });
                    }
                }
                "message_end" => {
                    if let Some(msg) = val.get("message").and_then(|v| v.as_object()) {
                        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
                        if role == "assistant" {
                            if msg.get("stopReason").and_then(|v| v.as_str()) == Some("error") {
                                let err_msg = msg
                                    .get("errorMessage")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Unknown Pi assistant error");
                                return Err(err_msg.to_string());
                            }
                            if let Some(content) = msg.get("content").and_then(|v| v.as_array()) {
                                let mut parts = Vec::new();
                                for block in content {
                                    if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                        if let Some(t) = block.get("text").and_then(|v| v.as_str())
                                        {
                                            parts.push(t);
                                        }
                                    }
                                }
                                if !parts.is_empty() {
                                    final_text = parts.join("");
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        let reply = if !final_text.trim().is_empty() {
            final_text
        } else {
            streamed_text
        };
        Ok((reply, tool_calls))
    }
}

impl PiSidecarAdapter for ProcessPiAdapter {
    fn mode(&self) -> &'static str {
        "pi-durable"
    }

    fn send_message(
        &mut self,
        workspace_root: &Path,
        envelope: &AmbientEnvelope,
    ) -> Result<PiTurnAck, String> {
        self.shutdown();

        let session_dir = workspace_root.join(".hub/pi-session");
        fs::create_dir_all(&session_dir)
            .map_err(|e| format!("failed to create pi-session dir: {e}"))?;

        let has_existing_session = fs::read_dir(&session_dir)
            .ok()
            .map(|entries| {
                entries.flatten().any(|entry| {
                    entry.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl")
                })
            })
            .unwrap_or(false);

        let pi_agent_dir = match &self.pi_agent_dir_override {
            Some(d) => d.clone(),
            None => default_pi_agent_dir()?,
        };
        let (default_provider, default_model) = read_pi_settings_defaults(&pi_agent_dir);

        let tools_json =
            serde_json::to_string(&vec![flow_tool_definition(), loop_tool_definition()])
                .unwrap_or_default();
        let prompt = Self::build_contextualized_prompt(envelope);

        let mut attachment_args = Vec::new();
        for att in &envelope.one_shot_attachments {
            if let Ok(abs) = canonicalize_in_workspace(workspace_root, &att.image_path) {
                attachment_args.push(format!("@{}", abs.display()));
            }
        }

        let mut cmd = Command::new(&self.bin_path);
        cmd.current_dir(workspace_root)
            .env("GAME_HUB_TOOLS_JSON", tools_json)
            .env("GAME_HUB_WORKSPACE_ROOT", workspace_root)
            .env("PI_CODING_AGENT_DIR", &pi_agent_dir)
            .args(["--mode", "json", "--no-themes", "--no-approve", "--session-dir"])
            .arg(&session_dir);

        if has_existing_session {
            cmd.arg("--continue");
        }
        if let Some(ref p) = default_provider {
            cmd.args(["--provider", p]);
        }
        if let Some(ref m) = default_model {
            cmd.args(["--model", m]);
        }
        cmd.arg("--");
        for att_arg in attachment_args {
            cmd.arg(att_arg);
        }
        cmd.arg(prompt);

        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // SAFETY: setsid() creates a new session/process group for clean group termination.
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
            .map_err(|e| format!("failed to spawn pi: {e}"))?;
        let pid = child.id() as libc::pid_t;

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let stdout_handle = thread::spawn(move || {
            let mut buf = String::new();
            if let Some(r) = stdout_pipe {
                let mut reader = BufReader::new(r);
                let mut line = String::new();
                while let Ok(n) = reader.read_line(&mut line) {
                    if n == 0 {
                        break;
                    }
                    buf.push_str(&line);
                    line.clear();
                }
            }
            buf
        });
        let stderr_handle = thread::spawn(move || {
            let mut buf = String::new();
            if let Some(mut r) = stderr_pipe {
                let _ = r.read_to_string(&mut buf);
            }
            buf
        });

        self.child = Some(child);

        let timeout = Duration::from_secs(180);
        let deadline = Instant::now() + timeout;
        let status = loop {
            let Some(ref mut c) = self.child else {
                return Err("pi process was terminated".to_string());
            };
            match c.try_wait() {
                Ok(Some(st)) => {
                    self.child = None;
                    break st;
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        unsafe {
                            libc::killpg(pid, libc::SIGTERM);
                        }
                        self.shutdown();
                        return Err("pi timed out after 180s".to_string());
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                Err(e) => {
                    self.child = None;
                    return Err(format!("failed waiting for pi: {e}"));
                }
            }
        };

        let stdout = stdout_handle.join().unwrap_or_default();
        let stderr = stderr_handle.join().unwrap_or_default();

        let (reply_text, tool_calls) = match Self::parse_pi_jsonl_output(&stdout) {
            Ok(parsed) => parsed,
            Err(err_msg) => return Err(err_msg),
        };

        if !status.success() && reply_text.trim().is_empty() {
            let detail = stderr.trim();
            return Err(if detail.is_empty() {
                format!("pi exited with status {status}")
            } else {
                detail.to_string()
            });
        }

        let turn_id = format!("turn-{}", TURN_COUNTER.fetch_add(1, Ordering::Relaxed));
        Ok(PiTurnAck {
            turn_id,
            mode: "pi-durable".to_string(),
            reply_text,
            tool_calls,
        })
    }

    fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            let pid = child.id() as libc::pid_t;
            // SAFETY: terminate the sidecar's process group cleanly.
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
    }
}

impl Drop for ProcessPiAdapter {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Creates the appropriate `PiSidecarAdapter` depending on `$PATH`.
pub fn create_pi_adapter(bin_name: &str) -> Box<dyn PiSidecarAdapter> {
    if let Some(path) = resolve_pi_binary(bin_name) {
        Box::new(ProcessPiAdapter::new(path))
    } else {
        Box::new(OfflinePiAdapter)
    }
}

/// Validates a workflow name against `^[a-zA-Z0-9_-]+$`.
pub fn validate_workflow_name(workflow: &str) -> Result<(), String> {
    if workflow.is_empty()
        || !workflow
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!(
            "invalid workflow '{workflow}': must match ^[a-zA-Z0-9_-]+$"
        ));
    }
    Ok(())
}

/// Validates a `--use` override against `^[a-zA-Z0-9_-]+=[a-zA-Z0-9_./:-]+$`.
pub fn validate_use_override(entry: &str) -> Result<(), String> {
    let Some((stage, target)) = entry.split_once('=') else {
        return Err(format!(
            "invalid --use override '{entry}': expected stage=cli:model"
        ));
    };
    let stage_ok = !stage.is_empty()
        && stage
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let target_ok = !target.is_empty()
        && target.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b':' | b'-')
        });
    if !stage_ok || !target_ok {
        return Err(format!(
            "invalid --use override '{entry}': must match ^[a-zA-Z0-9_-]+=[a-zA-Z0-9_./:-]+$"
        ));
    }
    Ok(())
}

/// Validates a loop `run_id` against `^[a-zA-Z0-9_-]+$`.
pub fn validate_loop_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || !run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!(
            "invalid run_id '{run_id}': must match ^[a-zA-Z0-9_-]+$"
        ));
    }
    Ok(())
}

fn default_preset_workflows() -> Vec<LoopWorkflowInfo> {
    vec![
        LoopWorkflowInfo {
            name: "fast-worker-reviewer".to_string(),
            source: "preset".to_string(),
            description: "Implementa e revisa em ciclo rápido".to_string(),
        },
        LoopWorkflowInfo {
            name: "designer-worker-reviewer".to_string(),
            source: "preset".to_string(),
            description: "Projeta a solução, implementa e revisa antes de aprovar".to_string(),
        },
        LoopWorkflowInfo {
            name: "worker-reviewer-critic".to_string(),
            source: "preset".to_string(),
            description: "Implementa, revisa e audita antes de aprovar".to_string(),
        },
        LoopWorkflowInfo {
            name: "planner-worker-tester-critic".to_string(),
            source: "preset".to_string(),
            description: "Planeja, implementa, testa e audita antes de aprovar".to_string(),
        },
    ]
}

fn parse_workflow_list_output(stdout: &str) -> Vec<LoopWorkflowInfo> {
    let mut workflows = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (name_part, rest_part) = if let Some((n, r)) = trimmed.split_once('\t') {
            (n.trim(), r.trim())
        } else if let Some((n, r)) = trimmed.split_once(char::is_whitespace) {
            (n.trim(), r.trim())
        } else {
            (trimmed, "")
        };
        if validate_workflow_name(name_part).is_err() {
            continue;
        }
        let mut source = "preset".to_string();
        let mut description = rest_part.to_string();
        if let Some(open_idx) = rest_part.find('[') {
            if let Some(close_rel) = rest_part[open_idx + 1..].find(']') {
                let close_idx = open_idx + 1 + close_rel;
                let src = rest_part[open_idx + 1..close_idx].trim();
                if !src.is_empty() {
                    source = src.to_string();
                }
                let after = rest_part[close_idx + 1..].trim();
                description = after
                    .trim_start_matches(['—', '-', '–', ':'])
                    .trim()
                    .to_string();
            }
        }
        workflows.push(LoopWorkflowInfo {
            name: name_part.to_string(),
            source,
            description,
        });
    }
    workflows
}

fn detect_auto_approve_status(output: &str) -> Option<bool> {
    let lower = output.to_ascii_lowercase();
    if !lower.contains("auto_approve_in_sandbox") {
        return None;
    }
    for line in lower.lines() {
        if !line.contains("auto_approve_in_sandbox") {
            continue;
        }
        if line.contains("false")
            || line.contains("desabilitad")
            || line.contains("disabled")
            || line.contains("não habilitad")
            || line.contains("nao habilitad")
            || line.contains("missing")
        {
            return Some(false);
        }
        if line.contains("true") || line.contains("habilitad") || line.contains("enabled") {
            return Some(true);
        }
    }
    None
}

fn snapshot_run_dirs(runs_dir: &Path) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(entries) = fs::read_dir(runs_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                set.insert(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    set
}

fn extract_run_id_from_log(log_text: &str) -> Option<String> {
    for line in log_text.lines() {
        let trimmed = line.trim();
        for prefix in ["RUN_ID:", "RUN_ID=", "run_id:", "run_id="] {
            if let Some(idx) = trimmed.find(prefix) {
                let after = trimmed[idx + prefix.len()..].trim();
                let token = after.split_whitespace().next().unwrap_or("");
                if validate_loop_run_id(token).is_ok() {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

fn try_detect_started_run(
    runs_dir: &Path,
    existing_runs: &HashSet<String>,
    launch_log_path: &Path,
) -> Option<LoopRunState> {
    if let Ok(log_text) = fs::read_to_string(launch_log_path) {
        if let Some(run_id) = extract_run_id_from_log(&log_text) {
            let run_dir = runs_dir.join(&run_id);
            let state_path = run_dir.join("state.json");
            if state_path.exists() {
                if let Ok(raw) = fs::read_to_string(&state_path) {
                    if let Ok(state) = parse_loop_run_state(&run_id, &run_dir, &raw) {
                        return Some(state);
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(runs_dir) {
        let mut candidates: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        candidates.sort();
        for run_dir in candidates.into_iter().rev() {
            let Some(name) = run_dir.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if existing_runs.contains(name) {
                continue;
            }
            let state_path = run_dir.join("state.json");
            if state_path.exists() {
                if let Ok(raw) = fs::read_to_string(&state_path) {
                    if let Ok(state) = parse_loop_run_state(name, &run_dir, &raw) {
                        return Some(state);
                    }
                }
            }
        }
    }
    None
}

/// Adapter boundary for `tchelvis loop`.
pub trait TchelvisAdapter: Send + Sync {
    fn list_workflows(&self, workspace_root: &Path) -> Result<Vec<LoopWorkflowInfo>, String>;
    fn check_loop(
        &self,
        workspace_root: &Path,
        workflow: &str,
        use_overrides: &[String],
    ) -> Result<LoopCheckResult, String>;
    fn dispatch_loop(
        &self,
        workspace_root: &Path,
        workflow: &str,
        title: &str,
        spec_markdown: &str,
        options: &DispatchLoopOptions,
    ) -> Result<LoopRunState, String>;
    fn stop_loop(&self, workspace_root: &Path, run_id: &str) -> Result<(), String>;
}

/// Default `TchelvisAdapter` that writes `.loops/inputs/<timestamp>-<slug>.md`
/// and invokes `tchelvis loop` CLI commands if available, or records an offline stub run.
pub struct DefaultTchelvisAdapter {
    pub bin_name: String,
}

impl TchelvisAdapter for DefaultTchelvisAdapter {
    fn list_workflows(&self, workspace_root: &Path) -> Result<Vec<LoopWorkflowInfo>, String> {
        let Some(bin_path) = find_binary_in_path(&self.bin_name) else {
            return Ok(default_preset_workflows());
        };
        let out = Command::new(bin_path)
            .current_dir(workspace_root)
            .args(["loop", "list"])
            .output();
        match out {
            Ok(output) if output.status.success() => {
                let parsed = parse_workflow_list_output(&String::from_utf8_lossy(&output.stdout));
                if parsed.is_empty() {
                    Ok(default_preset_workflows())
                } else {
                    Ok(parsed)
                }
            }
            _ => Ok(default_preset_workflows()),
        }
    }

    fn check_loop(
        &self,
        workspace_root: &Path,
        workflow: &str,
        use_overrides: &[String],
    ) -> Result<LoopCheckResult, String> {
        validate_workflow_name(workflow)?;
        for entry in use_overrides {
            validate_use_override(entry)?;
        }

        let Some(bin_path) = find_binary_in_path(&self.bin_name) else {
            return Ok(LoopCheckResult {
                ok: false,
                tchelvis_available: false,
                auto_approve_enabled: None,
                workflow: workflow.to_string(),
                output: "tchelvis binary not found in $PATH".to_string(),
            });
        };

        let mut args: Vec<String> = vec![
            "loop".to_string(),
            "check".to_string(),
            workflow.to_string(),
        ];
        for entry in use_overrides {
            args.push("--use".to_string());
            args.push(entry.clone());
        }

        let out = Command::new(bin_path)
            .current_dir(workspace_root)
            .args(&args)
            .output()
            .map_err(|e| format!("failed to run tchelvis loop check: {e}"))?;

        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let combined = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
            (false, false) => format!("{}\n{}", stdout.trim(), stderr.trim()),
            (false, true) => stdout.trim().to_string(),
            (true, false) => stderr.trim().to_string(),
            (true, true) => String::new(),
        };
        let auto_approve_enabled = detect_auto_approve_status(&combined);
        Ok(LoopCheckResult {
            ok: out.status.success(),
            tchelvis_available: true,
            auto_approve_enabled,
            workflow: workflow.to_string(),
            output: combined,
        })
    }

    fn dispatch_loop(
        &self,
        workspace_root: &Path,
        workflow: &str,
        title: &str,
        spec_markdown: &str,
        options: &DispatchLoopOptions,
    ) -> Result<LoopRunState, String> {
        validate_workflow_name(workflow)?;
        if let Some(mc) = options.max_cycles {
            if !(1..=20).contains(&mc) {
                return Err(format!("invalid max_cycles {mc}: must be between 1 and 20"));
            }
        }
        for entry in &options.use_overrides {
            validate_use_override(entry)?;
        }

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let slug = slugify(title);
        let run_stem = format!("{ts}-{slug}");

        let input_rel = format!(".loops/inputs/{run_stem}.md");
        let input_abs = canonicalize_in_workspace(workspace_root, &input_rel)?;
        if let Some(parent) = input_abs.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create .loops/inputs: {e}"))?;
        }

        let trimmed_title = title.trim();
        let trimmed_spec = spec_markdown.trim_start();
        let final_spec = if !trimmed_title.is_empty()
            && !trimmed_spec.starts_with(&format!("# {trimmed_title}"))
        {
            format!("# {trimmed_title}\n\n{spec_markdown}")
        } else {
            spec_markdown.to_string()
        };
        fs::write(&input_abs, final_spec.as_bytes())
            .map_err(|e| format!("failed to write loop spec: {e}"))?;

        if let Some(bin_path) = find_binary_in_path(&self.bin_name) {
            let runs_dir = workspace_root.join(".loops/runs");
            let existing_runs = snapshot_run_dirs(&runs_dir);

            let launch_log_rel = format!(".loops/inputs/{run_stem}.launch.log");
            let launch_log_abs = canonicalize_in_workspace(workspace_root, &launch_log_rel)?;
            let log_stdout = fs::File::create(&launch_log_abs)
                .map_err(|e| format!("failed to create launch log: {e}"))?;
            let log_stderr = log_stdout
                .try_clone()
                .map_err(|e| format!("failed to clone launch log handle: {e}"))?;

            let mut args: Vec<String> = vec![
                "loop".to_string(),
                "run".to_string(),
                workflow.to_string(),
                "--input-file".to_string(),
                input_abs.to_string_lossy().to_string(),
            ];
            if options.from_head {
                args.push("--from-head".to_string());
            }
            if let Some(mc) = options.max_cycles {
                args.push("--max-cycles".to_string());
                args.push(mc.to_string());
            }
            for entry in &options.use_overrides {
                args.push("--use".to_string());
                args.push(entry.clone());
            }

            let mut cmd = Command::new(bin_path);
            cmd.current_dir(workspace_root)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log_stdout))
                .stderr(Stdio::from(log_stderr));
            // Detached background session so the loop survives Hub close.
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("failed to launch tchelvis loop: {e}"))?;

            for _ in 0..50 {
                if let Some(state) =
                    try_detect_started_run(&runs_dir, &existing_runs, &launch_log_abs)
                {
                    return Ok(state);
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if let Some(state) =
                            try_detect_started_run(&runs_dir, &existing_runs, &launch_log_abs)
                        {
                            if status.success() {
                                return Ok(state);
                            }
                        }
                        let log_output = fs::read_to_string(&launch_log_abs).unwrap_or_default();
                        let detail = log_output.trim();
                        if !status.success() {
                            return Err(if detail.is_empty() {
                                format!("tchelvis loop run exited early with status {status}")
                            } else {
                                detail.to_string()
                            });
                        }
                        return Err(if detail.is_empty() {
                            "tchelvis loop run exited without creating state.json".to_string()
                        } else {
                            format!(
                                "tchelvis loop run exited without creating state.json: {detail}"
                            )
                        });
                    }
                    Ok(None) => {}
                    Err(e) => {
                        return Err(format!("failed to poll tchelvis process: {e}"));
                    }
                }
                thread::sleep(Duration::from_millis(50));
            }

            let now_iso = format_epoch_ms_rfc3339(ts * 1000);
            let display_title = if trimmed_title.is_empty() {
                workflow.to_string()
            } else {
                trimmed_title.to_string()
            };
            Ok(LoopRunState {
                run_id: run_stem,
                workflow: workflow.to_string(),
                title: display_title,
                status: "running".to_string(),
                raw_status: Some("RUNNING".to_string()),
                branch: None,
                worktree_path: None,
                current_stage: Some("starting".to_string()),
                current_cycle: Some(1),
                max_cycles: options.max_cycles,
                created_at: now_iso.clone(),
                updated_at: now_iso,
                stages: Vec::new(),
                files: Vec::new(),
                summary: Some("Iniciando execução do tchelvis loop...".to_string()),
                error: None,
                engine_pid: Some(child.id()),
            })
        } else {
            // Offline fallback: record initial state.json so LoopsPanel can display the dispatched run.
            let run_dir = workspace_root.join(".loops/runs").join(&run_stem);
            fs::create_dir_all(&run_dir)
                .map_err(|e| format!("failed to create offline run dir: {e}"))?;
            let now_iso = format_epoch_ms_rfc3339(ts * 1000);
            let display_title = if trimmed_title.is_empty() {
                workflow.to_string()
            } else {
                trimmed_title.to_string()
            };
            let state = LoopRunState {
                run_id: run_stem.clone(),
                workflow: workflow.to_string(),
                title: display_title,
                status: "queued-offline".to_string(),
                raw_status: Some("QUEUED_OFFLINE".to_string()),
                branch: None,
                worktree_path: None,
                current_stage: Some("spec-written".to_string()),
                current_cycle: Some(0),
                max_cycles: options.max_cycles,
                created_at: now_iso.clone(),
                updated_at: now_iso,
                stages: vec![LoopStage {
                    name: "spec-written".to_string(),
                    status: "pending".to_string(),
                    ..Default::default()
                }],
                files: Vec::new(),
                summary: Some(
                    "tchelvis binary not found in $PATH; spec saved for manual/offline execution."
                        .to_string(),
                ),
                error: None,
                engine_pid: None,
            };
            let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
            fs::write(run_dir.join("state.json"), json)
                .map_err(|e| format!("failed to write offline state.json: {e}"))?;
            Ok(state)
        }
    }

    fn stop_loop(&self, workspace_root: &Path, run_id: &str) -> Result<(), String> {
        validate_loop_run_id(run_id)?;
        let Some(bin_path) = find_binary_in_path(&self.bin_name) else {
            return Err("tchelvis binary not found in $PATH".to_string());
        };
        let out = Command::new(bin_path)
            .current_dir(workspace_root)
            .args(["loop", "stop", run_id])
            .output()
            .map_err(|e| format!("failed to run tchelvis loop stop: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            return Err(format!(
                "tchelvis loop stop failed: {} {}",
                stderr.trim(),
                stdout.trim()
            )
            .trim()
            .to_string());
        }
        Ok(())
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ActiveContext;
    use tempfile::TempDir;

    #[test]
    fn lens_slug_validation_and_publish_works() {
        assert!(validate_lens_slug("combat-stats-v2").is_ok());
        assert!(validate_lens_slug("BadSlug").is_err());
        assert!(validate_lens_slug("../escape").is_err());
        assert!(validate_lens_slug("a/b").is_err());
        assert!(validate_lens_slug("").is_err());

        let dir = TempDir::new().unwrap();
        let info = publish_lens(dir.path(), "map-view", "World Map", "<h1>Map</h1>").unwrap();
        assert_eq!(info.rel_path, ".hub/views/map-view.html");

        let list = list_lenses(dir.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "World Map");

        let html = read_lens_html(dir.path(), "map-view").unwrap();
        assert!(html.contains("<h1>Map</h1>"));
    }

    #[test]
    fn offline_pi_adapter_handles_ambient_envelope() {
        let dir = TempDir::new().unwrap();
        let mut adapter = OfflinePiAdapter;
        let env = AmbientEnvelope {
            user_message: "Test".to_string(),
            active_context: ActiveContext {
                focused_panel: "markdown".to_string(),
                open_tabs: vec!["gdd/01.md".to_string()],
                dirty_files: vec!["gdd/01.md".to_string()],
                latest_loop: None,
            },
            one_shot_attachments: vec![],
        };
        let ack = adapter.send_message(dir.path(), &env).unwrap();
        assert_eq!(ack.mode, "offline");
        assert!(ack.reply_text.contains("1 dirty file"));
    }

    #[test]
    fn dispatch_loop_writes_spec_and_offline_state() {
        let dir = TempDir::new().unwrap();
        let adapter = DefaultTchelvisAdapter {
            bin_name: "__nonexistent_tchelvis_bin__".to_string(),
        };
        let state = adapter
            .dispatch_loop(
                dir.path(),
                "fast-worker-reviewer",
                "Player Dash",
                "Implement dash",
                &DispatchLoopOptions::default(),
            )
            .unwrap();
        assert_eq!(state.status, "queued-offline");
        let input_path = dir.path().join(format!(".loops/inputs/{}.md", state.run_id));
        assert!(input_path.exists());
        let input_content = fs::read_to_string(input_path).unwrap();
        assert!(input_content.starts_with("# Player Dash\n\n"));
        assert!(dir
            .path()
            .join(format!(".loops/runs/{}/state.json", state.run_id))
            .exists());
    }

    #[test]
    fn tchelvis_adapter_parses_list_check_dispatch_and_early_error_with_fake_binary() {
        let dir = TempDir::new().unwrap();
        let fake_bin = dir.path().join("fake-tchelvis");
        fs::write(
            &fake_bin,
            r#"#!/usr/bin/env bash
set -euo pipefail
sub1="${1:-}"
sub2="${2:-}"
if [[ "$sub1" == "loop" && "$sub2" == "list" ]]; then
  printf "fast-worker-reviewer\t[preset] — Implementa e revisa\n"
  printf "custom-flow\t[local] — Fluxo custom\n"
  exit 0
fi
if [[ "$sub1" == "loop" && "$sub2" == "check" ]]; then
  echo "Workflow '$3' válido (sandbox: bwrap)."
  echo "auto_approve_in_sandbox = false"
  exit 0
fi
if [[ "$sub1" == "loop" && "$sub2" == "run" ]]; then
  shift 2
  wf="$1"; shift
  echo "ARGS=$wf $*"
  if [[ "$wf" == "fail-early" ]]; then
    echo "erro simulado: working tree sujo" >&2
    exit 2
  fi
  run_id="20261125-999999-test"
  mkdir -p ".loops/runs/$run_id"
  cat > ".loops/runs/$run_id/input.md" <<'EOF'
# Titulo Fake
EOF
  cat > ".loops/runs/$run_id/state.json" <<EOF
{"schema_version":1,"run_id":"$run_id","workflow":"$wf","status":"RUNNING","current_cycle":1,"max_cycles":3,"branch":"loop/$wf-$run_id","started_at_ms":1795573858846,"executions":[]}
EOF
  echo "RUN_ID: $run_id"
  exit 0
fi
if [[ "$sub1" == "loop" && "$sub2" == "stop" ]]; then
  exit 0
fi
exit 1
"#,
        )
        .unwrap();
        fs::set_permissions(&fake_bin, fs::Permissions::from_mode(0o755)).unwrap();

        let adapter = DefaultTchelvisAdapter {
            bin_name: fake_bin.to_string_lossy().to_string(),
        };

        let workflows = adapter.list_workflows(dir.path()).unwrap();
        assert_eq!(workflows.len(), 2);
        assert_eq!(workflows[0].name, "fast-worker-reviewer");
        assert_eq!(workflows[1].source, "local");

        let check = adapter
            .check_loop(
                dir.path(),
                "fast-worker-reviewer",
                &["implement=pi:opencode-go/deepseek-v4.1-flash".to_string()],
            )
            .unwrap();
        assert!(check.ok);
        assert!(check.tchelvis_available);
        assert_eq!(check.auto_approve_enabled, Some(false));

        let opts = DispatchLoopOptions {
            use_overrides: vec!["implement=pi:opencode-go/deepseek-v4.1-flash".to_string()],
            max_cycles: Some(3),
            from_head: true,
        };
        let state = adapter
            .dispatch_loop(
                dir.path(),
                "fast-worker-reviewer",
                "Titulo Fake",
                "Detalhes",
                &opts,
            )
            .unwrap();
        assert_eq!(state.run_id, "20261125-999999-test");
        assert_eq!(state.status, "running");
        assert_eq!(
            state.branch.as_deref(),
            Some("loop/fast-worker-reviewer-20261125-999999-test")
        );

        let err = adapter
            .dispatch_loop(dir.path(), "fail-early", "Erro", "Spec", &opts)
            .unwrap_err();
        assert!(err.contains("working tree sujo"));

        assert!(adapter
            .stop_loop(dir.path(), "20261125-999999-test")
            .is_ok());

        // Validation guards
        assert!(adapter
            .dispatch_loop(
                dir.path(),
                "bad workflow!",
                "T",
                "S",
                &DispatchLoopOptions::default()
            )
            .is_err());
        assert!(adapter
            .check_loop(dir.path(), "fast-worker-reviewer", &["bad".to_string()])
            .is_err());
        assert!(adapter.stop_loop(dir.path(), "../escape").is_err());
    }

    #[test]
    fn pi_setup_first_run_save_api_key_preserves_settings_and_logout() {
        let dir = TempDir::new().unwrap();
        let pi_agent_dir = dir.path().join("pi-agent");
        let hub_cfg_dir = dir.path().join("hub-cfg");
        fs::create_dir_all(&pi_agent_dir).unwrap();
        fs::create_dir_all(&hub_cfg_dir).unwrap();

        // Pre-populate settings.json with unrelated keys that must be preserved.
        fs::write(
            pi_agent_dir.join("settings.json"),
            r#"{"packages":["foo-pkg"],"skills":["bar-skill"],"lastChangelogVersion":"1.5.2"}"#,
        )
        .unwrap();

        let status0 = get_pi_setup_status_in(None, &pi_agent_dir, &hub_cfg_dir).unwrap();
        assert!(!status0.first_run_completed);
        assert!(status0.needs_setup);
        assert!(!status0.provider_ready);

        let secret = "sk-test-secret-never-leak-12345";
        let status1 = configure_pi_provider_in(
            None,
            &pi_agent_dir,
            &hub_cfg_dir,
            &PiConfigureProviderRequest {
                provider: "openrouter".to_string(),
                model: Some("anthropic/claude-sonnet-4.5".to_string()),
                api_key: Some(secret.to_string()),
                mark_completed: true,
            },
        )
        .unwrap();

        assert!(status1.first_run_completed);
        assert!(!status1.needs_setup);
        assert!(status1.provider_ready);
        assert_eq!(status1.active_provider.as_deref(), Some("openrouter"));
        assert_eq!(
            status1.active_model.as_deref(),
            Some("anthropic/claude-sonnet-4.5")
        );
        assert_eq!(status1.configured_providers, vec!["openrouter".to_string()]);

        // Never leak raw key in serialized PiSetupStatus.
        let serialized_status = serde_json::to_string(&status1).unwrap();
        assert!(!serialized_status.contains(secret));

        // auth.json has 0600 permissions.
        let auth_meta = fs::metadata(pi_agent_dir.join("auth.json")).unwrap();
        assert_eq!(auth_meta.permissions().mode() & 0o777, 0o600);

        // settings.json preserved existing keys.
        let settings_raw = fs::read_to_string(pi_agent_dir.join("settings.json")).unwrap();
        let settings_val: serde_json::Value = serde_json::from_str(&settings_raw).unwrap();
        assert_eq!(settings_val["packages"][0], "foo-pkg");
        assert_eq!(settings_val["skills"][0], "bar-skill");
        assert_eq!(settings_val["lastChangelogVersion"], "1.5.2");
        assert_eq!(settings_val["defaultProvider"], "openrouter");
        assert_eq!(
            settings_val["defaultModel"],
            "anthropic/claude-sonnet-4.5"
        );

        // Also add a second provider and verify logout removes only the target provider.
        configure_pi_provider_in(
            None,
            &pi_agent_dir,
            &hub_cfg_dir,
            &PiConfigureProviderRequest {
                provider: "deepseek".to_string(),
                model: Some("deepseek-chat".to_string()),
                api_key: Some("sk-deepseek-other".to_string()),
                mark_completed: false,
            },
        )
        .unwrap();

        let status2 =
            logout_pi_provider_in(None, &pi_agent_dir, &hub_cfg_dir, "openrouter").unwrap();
        assert_eq!(status2.configured_providers, vec!["deepseek".to_string()]);
    }

    #[test]
    fn pi_setup_offline_skip_clears_needs_setup() {
        let dir = TempDir::new().unwrap();
        let pi_agent_dir = dir.path().join("pi-agent");
        let hub_cfg_dir = dir.path().join("hub-cfg");
        fs::create_dir_all(&pi_agent_dir).unwrap();
        fs::create_dir_all(&hub_cfg_dir).unwrap();

        let status = configure_pi_provider_in(
            None,
            &pi_agent_dir,
            &hub_cfg_dir,
            &PiConfigureProviderRequest {
                provider: "offline".to_string(),
                model: None,
                api_key: None,
                mark_completed: true,
            },
        )
        .unwrap();
        assert!(status.first_run_completed);
        assert!(!status.needs_setup);
        assert!(!status.provider_ready);
    }

    #[test]
    fn process_pi_adapter_executes_json_mode_session_continue_and_tool_calls() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().join("ws");
        let pi_agent_dir = dir.path().join("pi-agent");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&pi_agent_dir).unwrap();
        fs::write(
            pi_agent_dir.join("settings.json"),
            r#"{"defaultProvider":"opencode-go","defaultModel":"deepseek-v4.1-flash"}"#,
        )
        .unwrap();

        let args_log = dir.path().join("pi-args.log");
        let fake_pi = dir.path().join("pi");
        let script = format!(
            r#"#!/usr/bin/env bash
set -euo pipefail
printf '%s ' "$@" | tr '\n' ' ' >> "{log}"
printf '\n' >> "{log}"
session_dir=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--session-dir" ]]; then
    session_dir="$arg"
  fi
  prev="$arg"
done
mkdir -p "$session_dir"
touch "$session_dir/session-1.jsonl"
echo '{{"type":"tool_execution_start","toolCallId":"tc-1","toolName":"read","args":{{"path":"gdd/01.md"}}}}'
echo '{{"type":"tool_execution_end","toolCallId":"tc-1","toolName":"read","result":{{"ok":true}},"isError":false}}'
echo '{{"type":"message_update","assistantMessageEvent":{{"type":"text_delta","delta":"Olá "}}}}'
echo '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"Olá mundo!"}}]}}}}'
"#,
            log = args_log.display()
        );
        fs::write(&fake_pi, script).unwrap();
        fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();

        let mut adapter = ProcessPiAdapter::with_agent_dir(fake_pi, pi_agent_dir);
        let env = AmbientEnvelope {
            user_message: "Oi Pi".to_string(),
            active_context: ActiveContext {
                focused_panel: "markdown".to_string(),
                open_tabs: vec!["gdd/01.md".to_string()],
                dirty_files: vec![],
                latest_loop: None,
            },
            one_shot_attachments: vec![],
        };

        // Turn 1: should NOT pass --continue
        let ack1 = adapter.send_message(&ws, &env).unwrap();
        assert_eq!(ack1.mode, "pi-durable");
        assert_eq!(ack1.reply_text, "Olá mundo!");
        assert_eq!(ack1.tool_calls.len(), 1);
        assert_eq!(ack1.tool_calls[0].name, "read");
        assert_eq!(ack1.tool_calls[0].status, "completed");

        // Turn 2: session-1.jsonl now exists -> MUST pass --continue
        let ack2 = adapter.send_message(&ws, &env).unwrap();
        assert_eq!(ack2.reply_text, "Olá mundo!");

        let logged = fs::read_to_string(&args_log).unwrap();
        let lines: Vec<&str> = logged.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("--mode json"));
        assert!(lines[0].contains("--session-dir"));
        assert!(lines[0].contains("--provider opencode-go"));
        assert!(lines[0].contains("--model deepseek-v4.1-flash"));
        assert!(!lines[0].contains("--continue"));
        assert!(lines[1].contains("--continue"));
    }
}
