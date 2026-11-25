use crate::types::{
    AmbientEnvelope, PiToolCall, PiTurnAck,
};
use crate::workspace::canonicalize_in_workspace;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};
use super::*;

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

/// Lets callers stop a running pi turn without taking the adapter lock the turn holds.
///
/// A turn records the epoch when it starts and stops once it changes. Cancelling while no
/// turn runs is harmless: the next turn starts from the new epoch.
#[derive(Clone, Debug, Default)]
pub struct PiCancelToken(std::sync::Arc<std::sync::atomic::AtomicU64>);

impl PiCancelToken {
    /// Asks the turn that is running now, if any, to stop.
    pub fn cancel(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }

    fn epoch(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// Subprocess-backed adapter for Pi Durable (`pi`) running in its own process group.
pub struct ProcessPiAdapter {
    bin_path: PathBuf,
    pi_agent_dir_override: Option<PathBuf>,
    child: Option<Child>,
    cancel: PiCancelToken,
}

impl ProcessPiAdapter {
    pub fn new(bin_path: PathBuf) -> Self {
        Self {
            bin_path,
            pi_agent_dir_override: None,
            child: None,
            cancel: PiCancelToken::default(),
        }
    }

    pub fn with_agent_dir(bin_path: PathBuf, pi_agent_dir: PathBuf) -> Self {
        Self {
            bin_path,
            pi_agent_dir_override: Some(pi_agent_dir),
            child: None,
            cancel: PiCancelToken::default(),
        }
    }

    /// Shares `token` so the owner can stop a turn without the adapter lock.
    pub fn with_cancel_token(mut self, token: PiCancelToken) -> Self {
        self.cancel = token;
        self
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
        let turn_epoch = self.cancel.epoch();

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
                    if self.cancel.epoch() != turn_epoch {
                        self.shutdown();
                        return Err("pi turn cancelled".to_string());
                    }
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

/// Creates the appropriate `PiSidecarAdapter` depending on `$PATH`; `cancel` stops its turns.
pub fn create_pi_adapter(bin_name: &str, cancel: &PiCancelToken) -> Box<dyn PiSidecarAdapter> {
    if let Some(path) = resolve_pi_binary(bin_name) {
        Box::new(ProcessPiAdapter::new(path).with_cancel_token(cancel.clone()))
    } else {
        Box::new(OfflinePiAdapter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ActiveContext;
    use tempfile::TempDir;

    /// Polls `cond` until it holds; panics after `limit` so a broken fake cannot hang the suite.
    fn wait_until(limit: Duration, cond: impl Fn() -> bool) {
        let deadline = Instant::now() + limit;
        while !cond() {
            assert!(Instant::now() < deadline, "condition not met within {limit:?}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn cancel_token_stops_a_running_turn_and_releases_the_adapter() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::{Arc, Mutex};

        let dir = TempDir::new().unwrap();
        let ws = dir.path().join("ws");
        let pi_agent_dir = dir.path().join("pi-agent");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&pi_agent_dir).unwrap();
        let started = dir.path().join("started");
        let fake_pi = dir.path().join("pi");
        fs::write(
            &fake_pi,
            format!("#!/usr/bin/env bash\ntouch '{}'\nexec sleep 30\n", started.display()),
        )
        .unwrap();
        fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();

        let token = PiCancelToken::default();
        let adapter = Arc::new(Mutex::new(
            ProcessPiAdapter::with_agent_dir(fake_pi, pi_agent_dir).with_cancel_token(token.clone()),
        ));
        let turn_adapter = Arc::clone(&adapter);
        let turn = thread::spawn(move || {
            let env = AmbientEnvelope {
                user_message: "long turn".to_string(),
                active_context: ActiveContext {
                    focused_panel: "chat".to_string(),
                    open_tabs: vec![],
                    dirty_files: vec![],
                    latest_loop: None,
                },
                one_shot_attachments: vec![],
            };
            turn_adapter.lock().unwrap().send_message(&ws, &env)
        });
        wait_until(Duration::from_secs(10), || started.exists());

        let cancelled_at = Instant::now();
        token.cancel();
        let result = turn.join().unwrap();
        assert!(
            cancelled_at.elapsed() < Duration::from_secs(5),
            "turn kept running {:?} after cancel",
            cancelled_at.elapsed()
        );
        let err = result.unwrap_err();
        assert!(err.contains("cancel"), "{err}");
        assert!(adapter.try_lock().is_ok(), "adapter lock must be free after a cancelled turn");
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
