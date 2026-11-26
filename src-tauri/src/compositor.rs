use crate::sidecar::find_binary_in_path;
use serde::Deserialize;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Parsed `openwindow>>ADDRESS,WORKSPACE,CLASS,TITLE` event from Hyprland `.socket2.sock`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenWindowEvent {
    pub address: String,
    pub workspace: String,
    pub class: String,
    pub title: String,
}

/// Parses a single line from Hyprland `.socket2.sock`.
pub fn parse_socket2_openwindow(line: &str) -> Option<OpenWindowEvent> {
    let rest = line.trim().strip_prefix("openwindow>>")?;
    let mut parts = rest.splitn(4, ',');
    let address = parts.next()?.to_string();
    let workspace = parts.next()?.to_string();
    let class = parts.next()?.to_string();
    let title = parts.next()?.to_string();
    Some(OpenWindowEvent {
        address,
        workspace,
        class,
        title,
    })
}

/// Builds a Hyprland `.socket.sock` batch command to float, resize, and center a window by PID.
pub fn build_float_center_command(pid: u32, width: u32, height: u32) -> String {
    format!(
        "[[BATCH]] dispatch setfloating pid:{pid}; dispatch resizewindowpixel exact {width} {height},pid:{pid}; dispatch centerwindow"
    )
}

#[derive(Deserialize, Debug, Clone)]
struct HyprClient {
    pid: i64,
    class: String,
    at: [i32; 2],
    size: [i32; 2],
    #[serde(default)]
    monitor: i64,
}

#[derive(Deserialize, Debug, Clone)]
struct HyprMonitor {
    id: i64,
    #[serde(default = "default_scale")]
    scale: f64,
}

fn default_scale() -> f64 {
    1.0
}

/// Formats `grim -g "<x>,<y> <w>x<h>"` geometry from logical coordinates and HiDPI scale.
pub fn format_grim_geometry(at: [i32; 2], size: [i32; 2], scale: f64) -> String {
    let s = if scale > 0.0 { scale } else { 1.0 };
    let x = ((at[0] as f64) * s).round() as i32;
    let y = ((at[1] as f64) * s).round() as i32;
    let w = ((size[0] as f64) * s).round().max(1.0) as i32;
    let h = ((size[1] as f64) * s).round().max(1.0) as i32;
    format!("{x},{y} {w}x{h}")
}

/// Parses `hyprctl clients -j` and `hyprctl monitors -j` for `target_pid` and returns
/// the scaled `grim -g` geometry string.
pub fn parse_pid_grim_geometry(
    clients_json: &str,
    monitors_json: &str,
    target_pid: u32,
) -> Result<String, String> {
    let clients: Vec<HyprClient> = serde_json::from_str(clients_json)
        .map_err(|e| format!("failed to parse hyprctl clients -j: {e}"))?;
    let monitors: Vec<HyprMonitor> = if monitors_json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(monitors_json).unwrap_or_default()
    };

    let client = clients
        .into_iter()
        .find(|c| c.pid == target_pid as i64)
        .ok_or_else(|| format!("no Hyprland window found for PID {target_pid}"))?;

    let scale = monitors
        .into_iter()
        .find(|m| m.id == client.monitor)
        .map(|m| m.scale)
        .unwrap_or(1.0);

    Ok(format_grim_geometry(client.at, client.size, scale))
}

/// Finds a Godot Editor client PID from `hyprctl clients -j`.
pub fn find_godot_editor_pid(clients_json: &str) -> Result<u32, String> {
    let clients: Vec<HyprClient> = serde_json::from_str(clients_json)
        .map_err(|e| format!("failed to parse hyprctl clients -j: {e}"))?;
    clients
        .into_iter()
        .find(|c| c.class == "Godot" || c.class == "org.godotengine.Editor")
        .and_then(|c| u32::try_from(c.pid).ok())
        .ok_or_else(|| "Godot Editor window is not currently open".to_string())
}

/// Compositor abstraction for floating preview windows and capturing frames.
pub trait CompositorAdapter: Send + Sync {
    fn backend_name(&self) -> &'static str;
    fn degraded_reason(&self) -> Option<String>;
    fn float_and_center_pid(&self, pid: u32, width: u32, height: u32) -> Result<(), String>;
    fn capture_pid_region(&self, pid: u32, out_path: &Path) -> Result<(), String>;
    fn focus_pid(&self, pid: u32) -> Result<(), String>;
    fn focus_godot_editor(&self) -> Result<(), String>;
}

/// Degraded no-op adapter used when Hyprland or `grim` is unavailable.
pub struct DegradedCompositorAdapter {
    pub reason: String,
}

impl CompositorAdapter for DegradedCompositorAdapter {
    fn backend_name(&self) -> &'static str {
        "degraded"
    }

    fn degraded_reason(&self) -> Option<String> {
        Some(self.reason.clone())
    }

    fn float_and_center_pid(&self, _pid: u32, _width: u32, _height: u32) -> Result<(), String> {
        Ok(())
    }

    fn capture_pid_region(&self, _pid: u32, _out_path: &Path) -> Result<(), String> {
        Err(format!("capture unavailable: {}", self.reason))
    }

    fn focus_pid(&self, _pid: u32) -> Result<(), String> {
        Err("focus not supported without Hyprland".to_string())
    }

    fn focus_godot_editor(&self) -> Result<(), String> {
        Err(format!("focus editor unavailable: {}", self.reason))
    }
}

/// Hyprland compositor adapter using `.socket.sock`, `hyprctl`, and `grim`.
pub struct HyprlandCompositorAdapter {
    socket_path: PathBuf,
    has_grim: bool,
}

impl HyprlandCompositorAdapter {
    pub fn detect() -> Box<dyn CompositorAdapter> {
        let Ok(sig) = std::env::var("HYPRLAND_INSTANCE_SIGNATURE") else {
            return Box::new(DegradedCompositorAdapter {
                reason: "HYPRLAND_INSTANCE_SIGNATURE not set (running without Hyprland)"
                    .to_string(),
            });
        };
        if sig.trim().is_empty() {
            return Box::new(DegradedCompositorAdapter {
                reason: "empty HYPRLAND_INSTANCE_SIGNATURE".to_string(),
            });
        }
        let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") else {
            return Box::new(DegradedCompositorAdapter {
                reason: "XDG_RUNTIME_DIR not set".to_string(),
            });
        };
        let socket_path = PathBuf::from(runtime_dir)
            .join("hypr")
            .join(&sig)
            .join(".socket.sock");
        if !socket_path.exists() {
            return Box::new(DegradedCompositorAdapter {
                reason: format!("Hyprland socket not found at {}", socket_path.display()),
            });
        }
        if find_binary_in_path("hyprctl").is_none() {
            return Box::new(DegradedCompositorAdapter {
                reason: "`hyprctl` not found in $PATH".to_string(),
            });
        }
        let has_grim = find_binary_in_path("grim").is_some();
        Box::new(Self {
            socket_path,
            has_grim,
        })
    }

    fn send_socket_command(&self, cmd: &str) -> Result<String, String> {
        let mut stream = UnixStream::connect(&self.socket_path)
            .map_err(|e| format!("failed to connect to Hyprland .socket.sock: {e}"))?;
        stream
            .write_all(cmd.as_bytes())
            .map_err(|e| format!("failed to write to Hyprland .socket.sock: {e}"))?;
        let mut resp = String::new();
        let _ = stream.read_to_string(&mut resp);
        Ok(resp)
    }
}

impl CompositorAdapter for HyprlandCompositorAdapter {
    fn backend_name(&self) -> &'static str {
        "hyprland"
    }

    fn degraded_reason(&self) -> Option<String> {
        if !self.has_grim {
            Some("`grim` not found in $PATH; frame capture disabled".to_string())
        } else {
            None
        }
    }

    fn float_and_center_pid(&self, pid: u32, width: u32, height: u32) -> Result<(), String> {
        let cmd = build_float_center_command(pid, width, height);
        self.send_socket_command(&cmd)?;
        Ok(())
    }

    fn capture_pid_region(&self, pid: u32, out_path: &Path) -> Result<(), String> {
        if !self.has_grim {
            return Err("`grim` not found in $PATH".to_string());
        }
        let clients_out = Command::new("hyprctl")
            .args(["clients", "-j"])
            .output()
            .map_err(|e| format!("failed to run hyprctl clients -j: {e}"))?;
        let clients_json = String::from_utf8_lossy(&clients_out.stdout);

        let monitors_out = Command::new("hyprctl")
            .args(["monitors", "-j"])
            .output()
            .map_err(|e| format!("failed to run hyprctl monitors -j: {e}"))?;
        let monitors_json = String::from_utf8_lossy(&monitors_out.stdout);

        let geom = parse_pid_grim_geometry(&clients_json, &monitors_json, pid)?;
        let status = Command::new("grim")
            .args(["-g", &geom])
            .arg(out_path)
            .status()
            .map_err(|e| format!("failed to run grim: {e}"))?;
        if !status.success() {
            return Err(format!("grim exited with status {status}"));
        }
        Ok(())
    }

    fn focus_pid(&self, pid: u32) -> Result<(), String> {
        self.send_socket_command(&format!("dispatch focuswindow pid:{pid}"))?;
        Ok(())
    }

    fn focus_godot_editor(&self) -> Result<(), String> {
        let clients_out = Command::new("hyprctl")
            .args(["clients", "-j"])
            .output()
            .map_err(|e| format!("failed to run hyprctl clients -j: {e}"))?;
        let clients_json = String::from_utf8_lossy(&clients_out.stdout);
        let pid = find_godot_editor_pid(&clients_json)?;
        self.send_socket_command(&format!("dispatch focuswindow pid:{pid}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_socket2_openwindow_event() {
        let ev = parse_socket2_openwindow(
            "openwindow>>55a1bc,1,Godot,My Game (DEBUG)\n",
        )
        .unwrap();
        assert_eq!(ev.address, "55a1bc");
        assert_eq!(ev.workspace, "1");
        assert_eq!(ev.class, "Godot");
        assert_eq!(ev.title, "My Game (DEBUG)");
        assert!(parse_socket2_openwindow("focusedmon>>DP-1,1").is_none());
    }

    #[test]
    fn builds_float_center_batch_command_for_pid() {
        let cmd = build_float_center_command(4242, 1280, 720);
        assert!(cmd.contains("setfloating pid:4242"));
        assert!(cmd.contains("resizewindowpixel exact 1280 720,pid:4242"));
        assert!(cmd.contains("centerwindow"));
    }

    #[test]
    fn parses_clients_json_with_hidpi_scale_for_grim() {
        let clients = r#"[
            {"pid": 1001, "class": "kitty", "at": [0, 0], "size": [800, 600], "monitor": 0},
            {"pid": 2002, "class": "Godot", "at": [100, 50], "size": [1280, 720], "monitor": 1}
        ]"#;
        let monitors = r#"[
            {"id": 0, "scale": 1.0},
            {"id": 1, "scale": 1.5}
        ]"#;

        let geom = parse_pid_grim_geometry(clients, monitors, 2002).unwrap();
        assert_eq!(geom, "150,75 1920x1080");

        let editor_pid = find_godot_editor_pid(clients).unwrap();
        assert_eq!(editor_pid, 2002);
    }
}
