use crate::types::{LoopRunState, LoopStage};
use crate::workspace::sha256_hex;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Deserialize;
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

/// Formats epoch milliseconds into an ISO-8601 / RFC-3339 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`).
pub fn format_epoch_ms_rfc3339(ms: u64) -> String {
    let total_secs = (ms / 1000) as i64;
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    // Howard Hinnant civil-from-days algorithm (UTC).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };

    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[derive(Deserialize)]
struct RawTchelvisExecution {
    #[serde(default)]
    cycle: Option<u32>,
    stage_id: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    started_at_ms: Option<u64>,
    #[serde(default)]
    finished_at_ms: Option<u64>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    verdict: Option<String>,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Deserialize)]
struct RawTchelvisState {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    workflow: Option<String>,
    status: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    current_cycle: Option<u32>,
    #[serde(default)]
    max_cycles: Option<u32>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    engine_pid: Option<u32>,
    #[serde(default)]
    heartbeat_at_ms: Option<u64>,
    #[serde(default)]
    last_activity_at_ms: Option<u64>,
    #[serde(default)]
    started_at_ms: Option<u64>,
    #[serde(default)]
    finished_at_ms: Option<u64>,
    #[serde(default)]
    executions: Vec<RawTchelvisExecution>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum LegacyStageEntry {
    Detailed(LoopStage),
    Name(String),
}

#[derive(Deserialize)]
struct LegacyLoopRunState {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    workflow: Option<String>,
    #[serde(default)]
    title: Option<String>,
    status: String,
    #[serde(default)]
    raw_status: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    worktree_path: Option<String>,
    #[serde(default)]
    current_stage: Option<String>,
    #[serde(default)]
    current_cycle: Option<u32>,
    #[serde(default)]
    max_cycles: Option<u32>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    stages: Vec<LegacyStageEntry>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    exit_summary: Vec<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    engine_pid: Option<u32>,
}

fn normalize_run_status(raw_status: &str) -> String {
    match raw_status.trim().to_ascii_uppercase().as_str() {
        "PASS" | "COMPLETED" | "DONE" => "completed".to_string(),
        "RUNNING" => "running".to_string(),
        "FAIL" | "FAILED" => "failed".to_string(),
        "ERROR" => "error".to_string(),
        "CANCELLED" | "CANCELED" | "STOPPED" => "cancelled".to_string(),
        _ => raw_status.trim().to_ascii_lowercase(),
    }
}

fn normalize_stage_status(outcome: Option<&str>, finished_at_ms: Option<u64>) -> String {
    match outcome.map(|s| s.trim().to_ascii_uppercase()).as_deref() {
        Some("OK" | "PASS" | "COMPLETED" | "DONE") => "completed".to_string(),
        Some("FAIL" | "FAILED" | "REJECT" | "CHANGES_REQUESTED") => "failed".to_string(),
        Some("ERROR") => "error".to_string(),
        Some("CANCELLED" | "CANCELED" | "STOPPED") => "cancelled".to_string(),
        Some("RUNNING") => "running".to_string(),
        Some(other) => other.to_ascii_lowercase(),
        None => {
            if finished_at_ms.is_some() {
                "completed".to_string()
            } else {
                "running".to_string()
            }
        }
    }
}

fn first_heading_or_line(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let cleaned = trimmed.trim_start_matches('#').trim();
        if !cleaned.is_empty() {
            return Some(cleaned.to_string());
        }
    }
    None
}

fn extract_tchelvis_title(run_id: &str, run_dir: &Path, workflow: &str) -> String {
    let input_path = run_dir.join("input.md");
    if let Ok(content) = fs::read_to_string(&input_path) {
        if let Some(title) = first_heading_or_line(&content) {
            return title;
        }
    }
    let frozen_path = run_dir.join("frozen.json");
    if let Ok(raw_frozen) = fs::read_to_string(&frozen_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw_frozen) {
            if let Some(prompt) = val.get("input_prompt").and_then(|v| v.as_str()) {
                if let Some(title) = first_heading_or_line(prompt) {
                    return title;
                }
            }
        }
    }
    if !workflow.trim().is_empty() {
        workflow.to_string()
    } else {
        run_id.to_string()
    }
}

fn detect_disk_worktree_path(run_id: &str, run_dir: &Path) -> Option<String> {
    let run_workspace = run_dir.join("workspace");
    if run_workspace.exists() {
        return Some(run_workspace.to_string_lossy().to_string());
    }
    if let Some(runs_parent) = run_dir.parent() {
        if let Some(loops_dir) = runs_parent.parent() {
            let wt = loops_dir.join("worktrees").join(run_id);
            if wt.exists() {
                return Some(wt.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Parses either a real `tchelvis loop` `state.json` (schema v1) or a legacy/offline `LoopRunState`.
pub fn parse_loop_run_state(
    run_id: &str,
    run_dir: &Path,
    raw: &str,
) -> Result<LoopRunState, String> {
    let val: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid state.json: {e}"))?;

    let is_tchelvis_v1 = val.get("schema_version").is_some()
        || val.get("executions").is_some()
        || val.get("started_at_ms").is_some();

    if is_tchelvis_v1 {
        let parsed: RawTchelvisState =
            serde_json::from_value(val).map_err(|e| format!("invalid tchelvis state: {e}"))?;
        let effective_run_id = parsed
            .run_id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| run_id.to_string());
        let workflow = parsed.workflow.unwrap_or_default();
        let raw_status = parsed.status.clone();
        let status = normalize_run_status(&raw_status);
        let title = extract_tchelvis_title(&effective_run_id, run_dir, &workflow);

        let stages: Vec<LoopStage> = parsed
            .executions
            .into_iter()
            .map(|ex| {
                let model = match (ex.provider.as_deref(), ex.model.as_deref()) {
                    (Some(p), Some(m)) if !p.is_empty() && !m.is_empty() => {
                        Some(format!("{p}:{m}"))
                    }
                    (_, Some(m)) if !m.is_empty() => Some(m.to_string()),
                    (Some(p), None) if !p.is_empty() => Some(p.to_string()),
                    _ => None,
                };
                LoopStage {
                    name: ex.stage_id,
                    role: ex.role,
                    model,
                    cycle: ex.cycle,
                    status: normalize_stage_status(ex.outcome.as_deref(), ex.finished_at_ms),
                    started_at: ex.started_at_ms.map(format_epoch_ms_rfc3339),
                    finished_at: ex.finished_at_ms.map(format_epoch_ms_rfc3339),
                    duration_ms: ex.duration_ms,
                    verdict: ex.verdict,
                    summary: ex.summary,
                }
            })
            .collect();

        let current_stage = stages
            .iter()
            .rev()
            .find(|s| s.status == "running")
            .or_else(|| stages.last())
            .map(|s| s.name.clone());

        let created_at = parsed
            .started_at_ms
            .map(format_epoch_ms_rfc3339)
            .unwrap_or_default();
        let updated_at = parsed
            .finished_at_ms
            .or(parsed.last_activity_at_ms)
            .or(parsed.heartbeat_at_ms)
            .or(parsed.started_at_ms)
            .map(format_epoch_ms_rfc3339)
            .unwrap_or_else(|| created_at.clone());

        let worktree_path = detect_disk_worktree_path(&effective_run_id, run_dir);

        return Ok(LoopRunState {
            run_id: effective_run_id,
            workflow,
            title,
            status,
            raw_status: Some(raw_status),
            branch: parsed.branch,
            worktree_path,
            current_stage,
            current_cycle: parsed.current_cycle,
            max_cycles: parsed.max_cycles,
            created_at,
            updated_at,
            stages,
            files: parsed.files,
            summary: parsed.summary,
            error: parsed.reason.filter(|r| !r.is_empty()),
            engine_pid: parsed.engine_pid,
        });
    }

    let legacy: LegacyLoopRunState =
        serde_json::from_value(val).map_err(|e| format!("invalid legacy state: {e}"))?;
    let effective_run_id = legacy
        .run_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| run_id.to_string());
    let workflow = legacy.workflow.unwrap_or_default();
    let title = legacy
        .title
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| extract_tchelvis_title(&effective_run_id, run_dir, &workflow));
    let stages: Vec<LoopStage> = legacy
        .stages
        .into_iter()
        .map(|entry| match entry {
            LegacyStageEntry::Detailed(s) => s,
            LegacyStageEntry::Name(name) => LoopStage {
                name,
                status: if is_terminal_status(&legacy.status) {
                    "completed".to_string()
                } else {
                    "running".to_string()
                },
                ..Default::default()
            },
        })
        .collect();
    let summary = legacy.summary.or_else(|| {
        if legacy.exit_summary.is_empty() {
            None
        } else {
            Some(legacy.exit_summary.join("\n"))
        }
    });
    let current_stage = legacy
        .current_stage
        .filter(|s| !s.is_empty())
        .or_else(|| stages.last().map(|s| s.name.clone()));

    Ok(LoopRunState {
        run_id: effective_run_id,
        workflow,
        title,
        status: legacy.status,
        raw_status: legacy.raw_status,
        branch: legacy.branch,
        worktree_path: legacy.worktree_path,
        current_stage,
        current_cycle: legacy.current_cycle,
        max_cycles: legacy.max_cycles,
        created_at: legacy.created_at.unwrap_or_default(),
        updated_at: legacy.updated_at.unwrap_or_default(),
        stages,
        files: legacy.files,
        summary,
        error: legacy.error,
        engine_pid: legacy.engine_pid,
    })
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
        let run_dir = state_path.parent().unwrap_or_else(|| Path::new("."));
        match parse_loop_run_state(run_id, run_dir, &raw) {
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
        status.trim().to_ascii_lowercase().as_str(),
        "completed" | "pass" | "done" | "failed" | "fail" | "error" | "cancelled" | "stopped"
    )
}

/// Lists all loop runs found in `.loops/runs/*/state.json`, sorted newest-first.
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
    runs.sort_by(|a, b| b.run_id.cmp(&a.run_id));
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

fn html_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn render_inline_markdown(raw: &str) -> String {
    let escaped = html_escape(raw);
    let mut out = String::with_capacity(escaped.len());
    let chars: Vec<char> = escaped.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '`' {
            if let Some(end) = chars[i + 1..].iter().position(|&c| c == '`') {
                let code: String = chars[i + 1..i + 1 + end].iter().collect();
                out.push_str("<code>");
                out.push_str(&code);
                out.push_str("</code>");
                i = i + 1 + end + 1;
                continue;
            }
        }
        if i + 1 < chars.len() && chars[i] == '*' && chars[i + 1] == '*' {
            let mut end_idx = None;
            let mut j = i + 2;
            while j + 1 < chars.len() {
                if chars[j] == '*' && chars[j + 1] == '*' {
                    end_idx = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(end) = end_idx {
                let inner: String = chars[i + 2..end].iter().collect();
                out.push_str("<strong>");
                out.push_str(&inner);
                out.push_str("</strong>");
                i = end + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn is_table_separator(line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.contains('|') || !trimmed.contains('-') {
        return false;
    }
    trimmed
        .chars()
        .all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
}

fn split_table_cells(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let inner = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let inner = inner.strip_suffix('|').unwrap_or(inner);
    inner
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect()
}

/// Converts a `report.md` document into self-contained HTML in the dark Hub theme.
pub fn render_markdown_report_html(markdown: &str) -> String {
    let mut body = String::new();
    let lines: Vec<&str> = markdown.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        // Fenced code blocks
        if let Some(fence_rest) = trimmed.strip_prefix("```") {
            let lang = html_escape(fence_rest.trim());
            i += 1;
            let mut code = String::new();
            while i < lines.len() && !lines[i].trim().starts_with("```") {
                code.push_str(&html_escape(lines[i]));
                code.push('\n');
                i += 1;
            }
            if i < lines.len() {
                i += 1;
            }
            body.push_str("<pre><code");
            if !lang.is_empty() {
                body.push_str(&format!(" class=\"language-{lang}\""));
            }
            body.push('>');
            body.push_str(&code);
            body.push_str("</code></pre>\n");
            continue;
        }

        // Headings
        if let Some(rest) = trimmed.strip_prefix("### ") {
            body.push_str(&format!("<h3>{}</h3>\n", render_inline_markdown(rest)));
            i += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("## ") {
            body.push_str(&format!("<h2>{}</h2>\n", render_inline_markdown(rest)));
            i += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            body.push_str(&format!("<h1>{}</h1>\n", render_inline_markdown(rest)));
            i += 1;
            continue;
        }

        // Markdown tables
        if trimmed.starts_with('|') && i + 1 < lines.len() && is_table_separator(lines[i + 1]) {
            let headers = split_table_cells(trimmed);
            i += 2;
            body.push_str("<table><thead><tr>");
            for h in &headers {
                body.push_str(&format!("<th>{}</th>", render_inline_markdown(h)));
            }
            body.push_str("</tr></thead><tbody>");
            while i < lines.len() && lines[i].trim().starts_with('|') {
                let row = split_table_cells(lines[i]);
                body.push_str("<tr>");
                for cell in &row {
                    body.push_str(&format!("<td>{}</td>", render_inline_markdown(cell)));
                }
                body.push_str("</tr>");
                i += 1;
            }
            body.push_str("</tbody></table>\n");
            continue;
        }

        // Unordered lists
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            body.push_str("<ul>\n");
            while i < lines.len() {
                let cur = lines[i].trim();
                if let Some(item) = cur.strip_prefix("- ").or_else(|| cur.strip_prefix("* ")) {
                    body.push_str(&format!("  <li>{}</li>\n", render_inline_markdown(item)));
                    i += 1;
                } else {
                    break;
                }
            }
            body.push_str("</ul>\n");
            continue;
        }

        // Ordered lists (e.g., `1. item`)
        if let Some((prefix, item)) = trimmed.split_once(". ") {
            if !prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_digit()) {
                body.push_str("<ol>\n");
                let mut first = true;
                while i < lines.len() {
                    let cur = lines[i].trim();
                    if let Some((p, rest)) = cur.split_once(". ") {
                        if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) {
                            let _ = first;
                            first = false;
                            body.push_str(&format!("  <li>{}</li>\n", render_inline_markdown(rest)));
                            i += 1;
                            continue;
                        }
                    }
                    break;
                }
                body.push_str("</ol>\n");
                continue;
            }
            let _ = item;
        }

        // Paragraph
        let mut para = Vec::new();
        while i < lines.len() {
            let cur = lines[i].trim();
            if cur.is_empty()
                || cur.starts_with('#')
                || cur.starts_with("```")
                || cur.starts_with("- ")
                || cur.starts_with("* ")
                || cur.starts_with('|')
            {
                break;
            }
            para.push(render_inline_markdown(cur));
            i += 1;
        }
        body.push_str(&format!("<p>{}</p>\n", para.join(" ")));
    }

    format!(
        r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root {{ color-scheme: dark; }}
  body {{
    font-family: Inter, system-ui, -apple-system, sans-serif;
    background: #14161c;
    color: #e2e8f0;
    margin: 0;
    padding: 16px 20px;
    line-height: 1.55;
    font-size: 13.5px;
  }}
  h1, h2, h3 {{ color: #f8fafc; margin: 16px 0 8px; line-height: 1.3; }}
  h1 {{ font-size: 18px; border-bottom: 1px solid #2d3343; padding-bottom: 6px; margin-top: 0; }}
  h2 {{ font-size: 15px; color: #93c5fd; }}
  h3 {{ font-size: 13.5px; color: #cbd5e1; }}
  p {{ margin: 8px 0; }}
  ul, ol {{ margin: 8px 0; padding-left: 20px; }}
  li {{ margin: 4px 0; }}
  code {{
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #1e222d;
    border: 1px solid #2d3343;
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 12px;
    color: #cbd5e1;
  }}
  pre {{
    background: #0f1117;
    border: 1px solid #2d3343;
    border-radius: 8px;
    padding: 10px 12px;
    overflow-x: auto;
    margin: 10px 0;
  }}
  pre code {{
    background: transparent;
    border: none;
    padding: 0;
    font-size: 12px;
    color: #e2e8f0;
  }}
  table {{
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 12.5px;
  }}
  th, td {{
    border: 1px solid #2d3343;
    padding: 6px 10px;
    text-align: left;
  }}
  th {{
    background: #1e222d;
    color: #93c5fd;
    font-weight: 600;
  }}
  tr:nth-child(even) td {{ background: rgba(30, 34, 45, 0.45); }}
</style>
</head>
<body>
{body}
</body>
</html>"#
    )
}

/// Reads `.loops/runs/<run_id>/report.html` (or converts `report.md` to self-contained HTML).
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
        let md = fs::read_to_string(&md_path)
            .map_err(|e| format!("failed to read report.md: {e}"))?;
        return Ok(render_markdown_report_html(&md));
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
            raw_status: Some("RUNNING".to_string()),
            branch: Some("loop/run-1".to_string()),
            worktree_path: Some(".loops/worktrees/run-1".into()),
            current_stage: Some("coding".to_string()),
            current_cycle: Some(1),
            max_cycles: Some(3),
            created_at: "2026-11-25T00:00:00Z".to_string(),
            updated_at: "2026-11-25T00:01:00Z".to_string(),
            stages: vec![
                LoopStage {
                    name: "plan".into(),
                    status: "completed".into(),
                    ..Default::default()
                },
                LoopStage {
                    name: "coding".into(),
                    status: "running".into(),
                    ..Default::default()
                },
            ],
            files: vec![],
            summary: None,
            error: None,
            engine_pid: None,
        };
        fs::write(&state_path, serde_json::to_string(&valid).unwrap()).unwrap();

        let mut cache = LoopStateCache::default();
        let first = cache.read_state_or_cached("run-1", &state_path).unwrap();
        assert_eq!(first.current_stage.as_deref(), Some("coding"));

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
            raw_status: None,
            branch: None,
            worktree_path: None,
            current_stage: Some("done".to_string()),
            current_cycle: Some(1),
            max_cycles: Some(1),
            created_at: "2026-11-25T00:00:00Z".to_string(),
            updated_at: "2026-11-25T00:05:00Z".to_string(),
            stages: vec![LoopStage {
                name: "done".into(),
                status: "completed".into(),
                ..Default::default()
            }],
            files: vec![],
            summary: Some("All tests passed".into()),
            error: None,
            engine_pid: None,
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

    #[test]
    fn parses_real_tchelvis_state_input_md_and_report_md() {
        let dir = TempDir::new().unwrap();
        let run_id = "20261125-023057-eec8";
        let run_dir = dir.path().join(".loops/runs").join(run_id);
        fs::create_dir_all(&run_dir).unwrap();
        fs::write(
            run_dir.join("input.md"),
            "# Adicionar nota de teste no README\n\nDetalhes extras aqui.\n",
        )
        .unwrap();
        fs::write(
            run_dir.join("state.json"),
            r#"{
              "schema_version": 1,
              "run_id": "20261125-023057-eec8",
              "workflow": "fast-worker-reviewer",
              "status": "PASS",
              "reason": null,
              "current_cycle": 1,
              "max_cycles": 2,
              "branch": "loop/fast-worker-reviewer-20261125-023057-eec8",
              "engine_pid": 2409830,
              "heartbeat_at_ms": 1795573892197,
              "last_activity_at_ms": 1795573892162,
              "started_at_ms": 1795573858846,
              "finished_at_ms": 1795573892197,
              "executions": [
                {
                  "cycle": 1,
                  "stage_id": "implement",
                  "role": "worker",
                  "provider": "pi",
                  "model": "opencode-go/deepseek-v4.1-flash",
                  "started_at_ms": 1795573858859,
                  "finished_at_ms": 1795573869256,
                  "duration_ms": 10397,
                  "verdict": null,
                  "outcome": "OK",
                  "log_file": "logs/c1-01-implement.log"
                },
                {
                  "cycle": 1,
                  "stage_id": "review",
                  "role": "reviewer",
                  "provider": "pi",
                  "model": "opencode-go/hy4-flash-free",
                  "started_at_ms": 1795573869277,
                  "finished_at_ms": 1795573892180,
                  "duration_ms": 22903,
                  "verdict": "PASS",
                  "outcome": "PASS",
                  "log_file": "logs/c1-02-review.log"
                }
              ],
              "files": ["README.md"],
              "summary": "Nenhum problema encontrado."
            }"#,
        )
        .unwrap();
        fs::write(
            run_dir.join("report.md"),
            "# Relatório <script>alert(1)</script>\n\n## Resumo\n\n- **Arquivo**: `README.md`\n\n| Etapa | Veredicto |\n|---|---|\n| review | PASS |\n\n```bash\necho ok\n```\n",
        )
        .unwrap();

        let mut cache = LoopStateCache::default();
        let runs = list_loop_runs(dir.path(), &mut cache).unwrap();
        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run.status, "completed");
        assert_eq!(run.raw_status.as_deref(), Some("PASS"));
        assert_eq!(run.title, "Adicionar nota de teste no README");
        assert_eq!(run.worktree_path, None);
        assert_eq!(run.branch.as_deref(), Some("loop/fast-worker-reviewer-20261125-023057-eec8"));
        assert_eq!(run.current_cycle, Some(1));
        assert_eq!(run.max_cycles, Some(2));
        assert_eq!(run.files, vec!["README.md"]);
        assert_eq!(run.stages.len(), 2);
        assert_eq!(run.stages[0].name, "implement");
        assert_eq!(run.stages[0].role.as_deref(), Some("worker"));
        assert_eq!(run.stages[0].model.as_deref(), Some("pi:opencode-go/deepseek-v4.1-flash"));
        assert_eq!(run.stages[0].status, "completed");
        assert_eq!(run.stages[1].verdict.as_deref(), Some("PASS"));
        assert!(is_terminal_status(&run.status));
        assert!(is_terminal_status("PASS"));

        let html = read_loop_report(dir.path(), run_id).unwrap();
        assert!(html.contains("<!doctype html>"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("<table>"));
        assert!(html.contains("<strong>Arquivo</strong>"));
        assert!(html.contains("<code>README.md</code>"));
        assert!(html.contains("<pre><code class=\"language-bash\">"));
    }

    #[test]
    fn list_loop_runs_sorts_newest_first() {
        let dir = TempDir::new().unwrap();
        for id in ["20261124-010000-aaaa", "20261125-020000-bbbb"] {
            let run_dir = dir.path().join(".loops/runs").join(id);
            fs::create_dir_all(&run_dir).unwrap();
            fs::write(
                run_dir.join("state.json"),
                format!(r#"{{"run_id":"{id}","workflow":"fast-worker-reviewer","status":"PASS","started_at_ms":1700000000000}}"#),
            )
            .unwrap();
        }
        let mut cache = LoopStateCache::default();
        let runs = list_loop_runs(dir.path(), &mut cache).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].run_id, "20261125-020000-bbbb");
        assert_eq!(runs[1].run_id, "20261124-010000-aaaa");
    }
}
