use crate::fs_watcher::format_epoch_ms_rfc3339;
use crate::types::{
    PiAuthCheckResult, PiConfigureProviderRequest, PiModelCatalog, PiModelInfo,
    PiProviderCatalogEntry, PiSetupStatus,
};
use crate::workspace::config_dir;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::os::unix::process::CommandExt;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use super::*;

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

pub(super) fn read_pi_settings_defaults(pi_agent_dir: &Path) -> (Option<String>, Option<String>) {
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

/// Model ids pi knows for `provider`, read from `models-store.json` (empty when absent).
fn collect_models_from_store(pi_agent_dir: &Path, provider: &str) -> Vec<String> {
    models_from_store(pi_agent_dir)
        .into_iter()
        .filter(|m| m.provider == provider)
        .map(|m| m.id)
        .collect()
}

/// Every model in `models-store.json`, across providers.
///
/// pi 1.5.x writes `{provider: {models: [...], etag, ...}}`. Older layouts
/// (`{provider: [...]}` and a top-level `{models: [{provider, ...}]}`) are still accepted.
pub(super) fn models_from_store(pi_agent_dir: &Path) -> Vec<PiModelInfo> {
    let Ok(raw) = fs::read_to_string(pi_agent_dir.join("models-store.json")) else {
        return Vec::new();
    };
    let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |info: Option<PiModelInfo>, out: &mut Vec<PiModelInfo>| {
        if let Some(info) = info {
            if seen.insert((info.provider.clone(), info.id.clone())) {
                out.push(info);
            }
        }
    };
    for (key, value) in obj.iter().filter(|(k, _)| k.as_str() != "models") {
        let entries = value
            .as_array()
            .or_else(|| value.get("models").and_then(|m| m.as_array()));
        for entry in entries.into_iter().flatten() {
            push(model_info_from_json(entry, Some(key)), &mut models);
        }
    }
    if let Some(arr) = obj.get("models").and_then(|v| v.as_array()) {
        for entry in arr {
            push(model_info_from_json(entry, None), &mut models);
        }
    }
    models
}

/// Maps one pi model entry (a bare id string or a pi `Model` object) to the safe DTO.
/// Only allow-listed fields are copied, so `baseUrl`, headers and keys never leave this function.
fn model_info_from_json(entry: &serde_json::Value, default_provider: Option<&str>) -> Option<PiModelInfo> {
    let non_empty = |v: Option<&serde_json::Value>| {
        v.and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if let Some(id) = non_empty(Some(entry)) {
        return Some(PiModelInfo {
            provider: default_provider?.to_string(),
            name: id.clone(),
            id,
            reasoning: false,
            image_input: false,
            context_window: None,
            max_output: None,
            cost_in: None,
            cost_out: None,
        });
    }
    let obj = entry.as_object()?;
    let id = non_empty(obj.get("id"))?;
    let provider = non_empty(obj.get("provider")).or_else(|| default_provider.map(str::to_string))?;
    let cost = obj.get("cost");
    Some(PiModelInfo {
        name: non_empty(obj.get("name")).unwrap_or_else(|| id.clone()),
        provider,
        id,
        reasoning: obj.get("reasoning").and_then(|v| v.as_bool()).unwrap_or(false),
        image_input: obj
            .get("input")
            .and_then(|v| v.as_array())
            .is_some_and(|kinds| kinds.iter().any(|k| k.as_str() == Some("image"))),
        context_window: obj.get("contextWindow").and_then(|v| v.as_u64()),
        max_output: obj.get("maxTokens").and_then(|v| v.as_u64()),
        cost_in: cost.and_then(|c| c.get("input")).and_then(|v| v.as_f64()),
        cost_out: cost.and_then(|c| c.get("output")).and_then(|v| v.as_f64()),
    })
}

/// Extracts the models from pi's RPC answer to `{"type":"get_available_models"}`.
/// Other JSONL lines (e.g. extension UI requests) are ignored.
fn parse_rpc_models_response(stdout: &str) -> Result<Vec<PiModelInfo>, String> {
    let response = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find(|v| {
            v.get("type").and_then(|t| t.as_str()) == Some("response")
                && v.get("command").and_then(|c| c.as_str()) == Some("get_available_models")
        })
        .ok_or_else(|| "pi did not answer get_available_models".to_string())?;
    if response.get("success").and_then(|v| v.as_bool()) != Some(true) {
        let reason = response
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("pi get_available_models failed: {reason}"));
    }
    let models = response
        .get("data")
        .and_then(|d| d.get("models"))
        .and_then(|m| m.as_array())
        .ok_or_else(|| "pi get_available_models response has no models".to_string())?;
    Ok(models
        .iter()
        .filter_map(|m| model_info_from_json(m, None))
        .collect())
}

/// Asks pi for every model of every connected provider, without touching the network or a session.
///
/// Errors are short and safe to show in the UI; pi's raw stderr (which may echo request headers)
/// only goes to the app's own stderr.
fn fetch_rpc_models(pi_bin: &Path, pi_agent_dir: &Path, timeout: Duration) -> Result<Vec<PiModelInfo>, String> {
    let mut cmd = Command::new(pi_bin);
    cmd.args(["--mode", "rpc", "--no-session", "--offline", "--no-approve"])
        .env("PI_CODING_AGENT_DIR", pi_agent_dir)
        // A neutral cwd that always exists; `--no-approve` already ignores project-local files.
        .current_dir(std::env::temp_dir());
    let (status, stdout, stderr) = run_command_capture_with_input(
        &mut cmd,
        Some(b"{\"type\":\"get_available_models\"}\n"),
        timeout,
    )?;
    parse_rpc_models_response(&stdout).map_err(|parse_err| {
        if !stderr.trim().is_empty() {
            eprintln!("[game-hub] pi_list_models: pi stderr: {}", stderr.trim());
        }
        if status.success() {
            parse_err
        } else {
            format!("pi exited with {status} without listing models")
        }
    })
}

fn curated_models() -> Vec<PiModelInfo> {
    CURATED_PROVIDERS
        .iter()
        .flat_map(|seed| {
            seed.suggested_models
                .iter()
                .filter_map(move |m| model_info_from_json(&serde_json::json!(m), Some(seed.id)))
        })
        .collect()
}

/// Lists models: pi RPC first, then `models-store.json`, then the curated suggestions.
pub fn list_pi_models_in(pi_bin: Option<&Path>, pi_agent_dir: &Path, timeout: Duration) -> PiModelCatalog {
    let rpc_failure = match pi_bin {
        None => "pi CLI binary not found in $PATH".to_string(),
        Some(bin) => match fetch_rpc_models(bin, pi_agent_dir, timeout) {
            Ok(models) if !models.is_empty() => {
                return PiModelCatalog {
                    source: "pi_rpc".to_string(),
                    models,
                    fallback_reason: None,
                }
            }
            Ok(_) => "pi reported no models (is a provider connected?)".to_string(),
            Err(e) => e,
        },
    };
    let store = models_from_store(pi_agent_dir);
    let (source, models) = if store.is_empty() {
        ("curated", curated_models())
    } else {
        ("models_store", store)
    };
    PiModelCatalog {
        source: source.to_string(),
        models,
        fallback_reason: Some(rpc_failure),
    }
}

fn run_command_capture_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<(std::process::ExitStatus, String, String), String> {
    run_command_capture_with_input(cmd, None, timeout)
}

/// Like `run_command_capture_with_timeout`, optionally writing `input` to stdin and then closing it.
///
/// The command runs in its own process group, and `timeout` bounds the whole call: waiting for
/// the process *and* draining its pipes. On timeout the entire group is killed, so nothing the
/// command started (e.g. a pi extension) outlives it or keeps us waiting on an open pipe.
fn run_command_capture_with_input(
    cmd: &mut Command,
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<(std::process::ExitStatus, String, String), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    // SAFETY: setsid() only detaches the child into a new session/process group before exec.
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
        .map_err(|e| format!("failed to spawn command: {e}"))?;
    let pgid = child.id() as libc::pid_t;
    let kill_group = || {
        // SAFETY: signals only the process group this function created.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    };
    let timed_out = || format!("command timed out after {}", describe_duration(timeout));

    if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
        let bytes = bytes.to_vec();
        // Written from a thread so a child that never reads stdin cannot block us; dropping closes it.
        thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        });
    }

    let (tx, rx) = mpsc::channel::<(bool, String)>();
    for (is_stdout, pipe) in [
        (true, child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
        (false, child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
    ] {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = String::new();
            if let Some(mut r) = pipe {
                let _ = r.read_to_string(&mut buf);
            }
            let _ = tx.send((is_stdout, buf));
        });
    }
    drop(tx);

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if Instant::now() >= deadline {
                    kill_group();
                    let _ = child.wait();
                    return Err(timed_out());
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                kill_group();
                let _ = child.wait();
                return Err(format!("failed waiting for command: {e}"));
            }
        }
    };

    let (mut stdout, mut stderr) = (None, None);
    while stdout.is_none() || stderr.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok((true, out)) => stdout = Some(out),
            Ok((false, err)) => stderr = Some(err),
            Err(_) => {
                // The command exited but something it started still holds a pipe open.
                kill_group();
                return Err(timed_out());
            }
        }
    }
    Ok((status, stdout.unwrap_or_default(), stderr.unwrap_or_default()))
}

/// `300ms` below one second, `5s` otherwise.
fn describe_duration(d: Duration) -> String {
    if d < Duration::from_secs(1) {
        format!("{}ms", d.as_millis())
    } else {
        format!("{}s", d.as_secs())
    }
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

/// Convenience wrapper listing models from the default `~/.pi/agent` (10 s budget for pi).
pub fn list_pi_models(bin_name: &str) -> Result<PiModelCatalog, String> {
    let pi_bin = resolve_pi_binary(bin_name);
    let pi_agent_dir = default_pi_agent_dir()?;
    Ok(list_pi_models_in(pi_bin.as_deref(), &pi_agent_dir, Duration::from_secs(10)))
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

#[cfg(test)]
mod tests {
    use super::*;

    use tempfile::TempDir;

    /// Mirrors the real pi 1.5.x `models-store.json` layout: `{provider: {models: [...], etag, ...}}`.
    fn write_real_shape_models_store(pi_agent_dir: &Path, provider: &str, count: usize) {
        let models: Vec<serde_json::Value> = (0..count)
            .map(|i| {
                serde_json::json!({
                    "id": format!("model-{i}"),
                    "name": format!("Model {i}"),
                    "api": "openai-completions",
                    "provider": provider,
                    "baseUrl": "https://example.invalid/v1",
                    "reasoning": i % 2 == 0,
                })
            })
            .collect();
        let store = serde_json::json!({
            provider: {
                "models": models,
                "etag": "W/\"abc\"",
                "lastModified": "Tue, 24 Nov 2026 10:00:00 GMT",
                "checkedAt": 1764000000000u64,
            }
        });
        fs::write(pi_agent_dir.join("models-store.json"), store.to_string()).unwrap();
    }

    fn write_fake_pi(dir: &Path, body: &str) -> std::path::PathBuf {
        let fake_pi = dir.join("pi");
        fs::write(&fake_pi, format!("#!/usr/bin/env bash\nset -uo pipefail\n{body}\n")).unwrap();
        fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();
        fake_pi
    }

    const RPC_MODELS_RESPONSE: &str = r#"{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"id":"deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","api":"openai-completions","provider":"opencode-go","baseUrl":"https://secret.example.invalid","headers":{"x-key":"k"},"reasoning":true,"input":["text"],"cost":{"input":0.1,"output":0.4},"contextWindow":128000,"maxTokens":8192},{"id":"claude-haiku-5-5","name":"Claude Haiku 5.5","provider":"opencode-go","reasoning":false,"input":["text","image"],"contextWindow":1000000,"maxTokens":128000},{"name":"missing id is skipped","provider":"opencode-go"}]}}"#;

    #[test]
    fn models_store_real_shape_lists_every_provider_model() {
        let dir = TempDir::new().unwrap();
        let pi_agent_dir = dir.path().join("pi-agent");
        let hub_cfg_dir = dir.path().join("hub-cfg");
        fs::create_dir_all(&pi_agent_dir).unwrap();
        fs::create_dir_all(&hub_cfg_dir).unwrap();
        write_real_shape_models_store(&pi_agent_dir, "opencode-go", 33);
        fs::write(
            pi_agent_dir.join("settings.json"),
            r#"{"defaultProvider":"opencode-go","defaultModel":"model-0"}"#,
        )
        .unwrap();

        let ids = collect_models_from_store(&pi_agent_dir, "opencode-go");
        assert_eq!(ids.len(), 33);
        assert_eq!(ids[0], "model-0");
        assert!(collect_models_from_store(&pi_agent_dir, "openai").is_empty());

        let status = get_pi_setup_status_in(None, &pi_agent_dir, &hub_cfg_dir).unwrap();
        for i in 0..33 {
            assert!(
                status.available_models.contains(&format!("model-{i}")),
                "setup status must expose model-{i}"
            );
        }

        let store_models = models_from_store(&pi_agent_dir);
        assert_eq!(store_models.len(), 33);
        assert_eq!(store_models[0].provider, "opencode-go");
        assert_eq!(store_models[0].name, "Model 0");
        assert!(store_models[0].reasoning);
    }

    #[test]
    fn models_store_legacy_shapes_still_parse() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("models-store.json"),
            r#"{"openai":["gpt-a",{"id":"gpt-b"}],"models":[{"id":"x-1","provider":"xai"},{"id":"o-1","provider":"openai"}]}"#,
        )
        .unwrap();
        assert_eq!(
            collect_models_from_store(dir.path(), "openai"),
            vec!["gpt-a".to_string(), "gpt-b".to_string(), "o-1".to_string()]
        );
        assert_eq!(collect_models_from_store(dir.path(), "xai"), vec!["x-1".to_string()]);
    }

    #[test]
    fn rpc_models_response_is_parsed_without_secret_fields() {
        // Extensions may print UI requests before the response line; they must be ignored.
        let stdout = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"extension_ui_request","id":"1","method":"setWidget","widgetKey":"w"}"#,
            RPC_MODELS_RESPONSE,
            r#"{"type":"extension_ui_request","id":"2","method":"setStatus","statusKey":"s"}"#
        );
        let models = parse_rpc_models_response(&stdout).unwrap();
        assert_eq!(models.len(), 2);
        let first = &models[0];
        assert_eq!(first.provider, "opencode-go");
        assert_eq!(first.id, "deepseek-v4.1-flash");
        assert_eq!(first.name, "DeepSeek V4.1 Flash");
        assert!(first.reasoning);
        assert!(!first.image_input);
        assert_eq!(first.context_window, Some(128000));
        assert_eq!(first.max_output, Some(8192));
        assert_eq!(first.cost_in, Some(0.1));
        assert_eq!(first.cost_out, Some(0.4));
        assert!(models[1].image_input);
        assert_eq!(models[1].cost_in, None);

        let serialized = serde_json::to_string(&models).unwrap();
        for forbidden in ["baseUrl", "base_url", "headers", "secret.example", "x-key"] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}: {serialized}");
        }
    }

    #[test]
    fn rpc_models_response_reports_failure() {
        let err = parse_rpc_models_response(
            r#"{"type":"response","command":"get_available_models","success":false,"error":"boom"}"#,
        )
        .unwrap_err();
        assert!(err.contains("boom"), "{err}");
        assert!(parse_rpc_models_response("not json\n").is_err());
    }

    #[test]
    fn list_models_uses_pi_rpc_with_offline_ephemeral_flags() {
        let dir = TempDir::new().unwrap();
        let pi_agent_dir = dir.path().join("pi-agent");
        fs::create_dir_all(&pi_agent_dir).unwrap();
        let args_log = dir.path().join("args.log");
        let stdin_log = dir.path().join("stdin.log");
        let fake_pi = write_fake_pi(
            dir.path(),
            &format!(
                "printf '%s ' \"$@\" > '{args}'\nprintf '%s' \"$PI_CODING_AGENT_DIR\" >> '{args}'\nread -r line\nprintf '%s' \"$line\" > '{stdin}'\necho '{resp}'",
                args = args_log.display(),
                stdin = stdin_log.display(),
                resp = RPC_MODELS_RESPONSE
            ),
        );

        let catalog =
            list_pi_models_in(Some(&fake_pi), &pi_agent_dir, Duration::from_secs(10));
        assert_eq!(catalog.source, "pi_rpc");
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.fallback_reason, None);

        let args = fs::read_to_string(&args_log).unwrap();
        for flag in ["--mode rpc", "--no-session", "--offline", "--no-approve"] {
            assert!(args.contains(flag), "missing {flag} in {args}");
        }
        assert!(args.ends_with(&pi_agent_dir.display().to_string()), "{args}");
        let sent: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&stdin_log).unwrap()).unwrap();
        assert_eq!(sent["type"], "get_available_models");
    }

    #[test]
    fn list_models_falls_back_to_store_then_curated() {
        let dir = TempDir::new().unwrap();
        let pi_agent_dir = dir.path().join("pi-agent");
        fs::create_dir_all(&pi_agent_dir).unwrap();
        let failing_pi = write_fake_pi(dir.path(), "echo 'pi exploded' >&2\nexit 3");

        // No store yet: curated suggestions, with the reason pi could not be read.
        let curated = list_pi_models_in(Some(&failing_pi), &pi_agent_dir, Duration::from_secs(10));
        assert_eq!(curated.source, "curated");
        assert!(!curated.models.is_empty());
        assert!(curated.fallback_reason.is_some());
        assert!(curated
            .models
            .iter()
            .any(|m| m.provider == "opencode-go" && m.id == "deepseek-v4.1-flash"));

        // Store present: models-store wins over curated.
        write_real_shape_models_store(&pi_agent_dir, "opencode-go", 33);
        let store = list_pi_models_in(Some(&failing_pi), &pi_agent_dir, Duration::from_secs(10));
        assert_eq!(store.source, "models_store");
        assert_eq!(store.models.len(), 33);
        let reason = store.fallback_reason.unwrap();
        assert!(reason.contains("exited"), "{reason}");
        assert!(!reason.contains("pi exploded"), "raw stderr must stay out of the UI: {reason}");

        // No pi binary at all: still falls back, explaining why.
        let no_bin = list_pi_models_in(None, &pi_agent_dir, Duration::from_secs(10));
        assert_eq!(no_bin.source, "models_store");
        assert!(no_bin.fallback_reason.is_some());
    }

    fn pid_is_gone(pid: i32) -> bool {
        // SAFETY: signal 0 only checks for existence; it never delivers a signal.
        unsafe { libc::kill(pid, 0) != 0 }
    }

    #[test]
    fn runner_timeout_is_honoured_when_a_grandchild_keeps_stdout_open() {
        let dir = TempDir::new().unwrap();
        let pid_file = dir.path().join("grandchild.pid");
        // pi exits at once but leaves a background child holding the stdout pipe.
        let fake = write_fake_pi(
            dir.path(),
            &format!("sleep 30 &\necho $! > '{}'\nexit 0", pid_file.display()),
        );
        let started = Instant::now();
        let result =
            run_command_capture_with_input(&mut Command::new(&fake), None, Duration::from_millis(300));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "runner ignored its timeout: {:?}",
            started.elapsed()
        );
        let err = result.unwrap_err();
        assert!(err.contains("timed out after 300ms"), "{err}");
        let grandchild: i32 = fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !pid_is_gone(grandchild) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(pid_is_gone(grandchild), "grandchild {grandchild} survived the timeout");
    }

    #[test]
    fn runner_timeout_kills_the_whole_process_group() {
        let dir = TempDir::new().unwrap();
        let pid_file = dir.path().join("grandchild.pid");
        let fake = write_fake_pi(
            dir.path(),
            &format!("sleep 30 >/dev/null 2>&1 &\necho $! > '{}'\nexec sleep 30", pid_file.display()),
        );
        let result =
            run_command_capture_with_input(&mut Command::new(&fake), None, Duration::from_millis(300));
        assert!(result.unwrap_err().contains("timed out"));
        let grandchild: i32 = fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !pid_is_gone(grandchild) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(pid_is_gone(grandchild), "grandchild {grandchild} survived the timeout");
    }

    #[test]
    fn list_models_hides_raw_pi_stderr_and_works_without_agent_dir() {
        let dir = TempDir::new().unwrap();
        let missing_agent_dir = dir.path().join("does-not-exist");
        let pi = write_fake_pi(
            dir.path(),
            &format!(
                "echo 'Authorization: Bearer sk-live-SECRET' >&2\nexit 1\n# {}",
                RPC_MODELS_RESPONSE.len()
            ),
        );
        let catalog = list_pi_models_in(Some(&pi), &missing_agent_dir, Duration::from_secs(10));
        assert_eq!(catalog.source, "curated");
        let reason = catalog.fallback_reason.unwrap();
        assert!(!reason.contains("SECRET"), "raw stderr leaked to the UI: {reason}");
        assert!(!reason.contains("spawn"), "missing agent dir must not look like a missing binary: {reason}");
        assert!(reason.contains("exited"), "{reason}");
    }

    #[test]
    fn list_models_times_out_and_falls_back() {
        let dir = TempDir::new().unwrap();
        let pi_agent_dir = dir.path().join("pi-agent");
        fs::create_dir_all(&pi_agent_dir).unwrap();
        // `exec` so the timeout kill reaches the process holding stdout open.
        let hanging_pi = write_fake_pi(dir.path(), "exec sleep 30");
        let catalog = list_pi_models_in(Some(&hanging_pi), &pi_agent_dir, Duration::from_millis(300));
        assert_eq!(catalog.source, "curated");
        assert!(catalog.fallback_reason.unwrap().contains("timed out"));
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
}
