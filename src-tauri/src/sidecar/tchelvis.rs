use crate::fs_watcher::{format_epoch_ms_rfc3339, parse_loop_run_state};
use crate::types::{
    DispatchLoopOptions, LoopCheckResult, LoopRunState, LoopStage,
    LoopWorkflowInfo,
};
use crate::workspace::canonicalize_in_workspace;
use std::collections::HashSet;
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use super::*;

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

#[cfg(test)]
mod tests {
    use super::*;
    
    use tempfile::TempDir;

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
}
