use crate::sidecar::find_binary_in_path;
use crate::types::{BrowserBounds, BrowserPanelState, BrowserSnapshotResult};
use base64::Engine as _;
use serde::Deserialize;
use std::process::Command;
use std::sync::Mutex;

pub const BROWSER_WEBVIEW_LABEL: &str = "browser-child";
pub const DEFAULT_BROWSER_URL: &str = "https://labs.google/fx/tools/flow";

const BLOCKED_SCHEMES: &[&str] = &[
    "file:",
    "javascript:",
    "data:",
    "vbscript:",
    "tauri:",
    "ipc:",
    "asset:",
    "about:",
    "blob:",
];

/// Returns `true` only if `raw` is a well-formed `http://` or `https://` URL with a non-empty host
/// and no whitespace or control characters.
pub fn is_allowed_browser_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }

    let lower = trimmed.to_ascii_lowercase();
    let after_scheme = if let Some(rest) = lower.strip_prefix("https://") {
        rest
    } else if let Some(rest) = lower.strip_prefix("http://") {
        rest
    } else {
        return false;
    };

    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return false;
    }

    let host_port = authority.rsplit('@').next().unwrap_or("");
    let host = if host_port.starts_with('[') {
        host_port
            .strip_prefix('[')
            .and_then(|s| s.split(']').next())
            .unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    };

    !host.is_empty()
}

/// Normalizes a user-entered URL (defaulting to `https://`, or `http://` for localhost/127.0.0.1)
/// and rejects any non-HTTP(S) scheme.
pub fn normalize_and_validate_browser_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL must not be empty".to_string());
    }

    let lower = trimmed.to_ascii_lowercase();
    for scheme in BLOCKED_SCHEMES {
        if lower.starts_with(scheme) {
            return Err(format!(
                "blocked URL scheme in '{trimmed}' (only http:// and https:// are allowed)"
            ));
        }
    }

    let candidate = if let Some(rest) = trimmed.get(7..).filter(|_| lower.starts_with("http://")) {
        format!("http://{rest}")
    } else if let Some(rest) = trimmed.get(8..).filter(|_| lower.starts_with("https://")) {
        format!("https://{rest}")
    } else if trimmed.contains("://") {
        return Err(format!(
            "blocked URL scheme in '{trimmed}' (only http:// and https:// are allowed)"
        ));
    } else if is_local_host_prefix(&lower) {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    };

    if is_allowed_browser_url(&candidate) {
        Ok(candidate)
    } else {
        Err(format!("invalid browser URL: '{trimmed}'"))
    }
}

fn is_local_host_prefix(lower: &str) -> bool {
    for prefix in ["localhost", "127.0.0.1"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            if rest.is_empty()
                || rest.starts_with(':')
                || rest.starts_with('/')
                || rest.starts_with('?')
                || rest.starts_with('#')
            {
                return true;
            }
        }
    }
    false
}

#[derive(Deserialize)]
struct HyprActiveWindow {
    at: [i32; 2],
    #[allow(dead_code)]
    size: [i32; 2],
    #[serde(default)]
    monitor: i64,
}

#[derive(Deserialize)]
struct HyprMonitor {
    id: i64,
    #[serde(default = "default_scale")]
    scale: f64,
}

fn default_scale() -> f64 {
    1.0
}

/// Computes the `grim -g "<x>,<y> <w>x<h>"` physical-pixel region string from Hyprland window/monitor JSON.
pub fn compute_grim_region_for_bounds(
    active_window_json: &str,
    monitors_json: &str,
    bounds: &BrowserBounds,
) -> Result<String, String> {
    let win: HyprActiveWindow = serde_json::from_str(active_window_json)
        .map_err(|e| format!("failed to parse hyprctl activewindow JSON: {e}"))?;
    let monitors: Vec<HyprMonitor> = serde_json::from_str(monitors_json)
        .map_err(|e| format!("failed to parse hyprctl monitors JSON: {e}"))?;

    let scale = monitors
        .into_iter()
        .find(|m| m.id == win.monitor)
        .map(|m| m.scale)
        .filter(|s| *s > 0.0)
        .unwrap_or(1.0);

    let logical_x = (win.at[0] as f64) + bounds.x.max(0.0);
    let logical_y = (win.at[1] as f64) + bounds.y.max(0.0);
    let logical_w = bounds.width.max(1.0);
    let logical_h = bounds.height.max(1.0);

    let px = (logical_x * scale).round() as i32;
    let py = (logical_y * scale).round() as i32;
    let pw = (logical_w * scale).round().max(1.0) as i32;
    let ph = (logical_h * scale).round().max(1.0) as i32;

    Ok(format!("{px},{py} {pw}x{ph}"))
}

/// Captures the BrowserPanel viewport region via Hyprland (`hyprctl` + `grim`),
/// returning a clean `canvas_fallback` result when running headless or outside Hyprland.
pub fn capture_region_snapshot(bounds: &BrowserBounds) -> Result<BrowserSnapshotResult, String> {
    let width = bounds.width.round().max(1.0) as u32;
    let height = bounds.height.round().max(1.0) as u32;

    let has_hypr_env = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    if !has_hypr_env
        || find_binary_in_path("hyprctl").is_none()
        || find_binary_in_path("grim").is_none()
    {
        return Ok(BrowserSnapshotResult {
            data_url: None,
            width,
            height,
            backend: "canvas_fallback".to_string(),
            fallback_reason: Some(
                "Hyprland/grim not available in current environment".to_string(),
            ),
        });
    }

    match try_capture_hyprland_grim(bounds, width, height) {
        Ok(res) => Ok(res),
        Err(reason) => Ok(BrowserSnapshotResult {
            data_url: None,
            width,
            height,
            backend: "canvas_fallback".to_string(),
            fallback_reason: Some(reason),
        }),
    }
}

fn try_capture_hyprland_grim(
    bounds: &BrowserBounds,
    width: u32,
    height: u32,
) -> Result<BrowserSnapshotResult, String> {
    let active_out = Command::new("hyprctl")
        .args(["activewindow", "-j"])
        .output()
        .map_err(|e| format!("failed to run hyprctl activewindow: {e}"))?;
    if !active_out.status.success() {
        return Err("hyprctl activewindow returned non-zero status".to_string());
    }
    let active_json = String::from_utf8_lossy(&active_out.stdout);

    let monitors_out = Command::new("hyprctl")
        .args(["monitors", "-j"])
        .output()
        .map_err(|e| format!("failed to run hyprctl monitors: {e}"))?;
    if !monitors_out.status.success() {
        return Err("hyprctl monitors returned non-zero status".to_string());
    }
    let monitors_json = String::from_utf8_lossy(&monitors_out.stdout);

    let geom = compute_grim_region_for_bounds(&active_json, &monitors_json, bounds)?;

    let tmp_file = tempfile::Builder::new()
        .prefix("hub-browser-snap-")
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("failed to create temp snapshot file: {e}"))?;
    let tmp_path = tmp_file.path().to_path_buf();

    let grim_out = Command::new("grim")
        .arg("-g")
        .arg(&geom)
        .arg(&tmp_path)
        .output()
        .map_err(|e| format!("failed to execute grim: {e}"))?;
    if !grim_out.status.success() {
        let stderr = String::from_utf8_lossy(&grim_out.stderr);
        return Err(format!("grim failed: {stderr}"));
    }

    let bytes =
        std::fs::read(&tmp_path).map_err(|e| format!("failed to read grim snapshot: {e}"))?;
    const PNG_MAGIC: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < PNG_MAGIC.len() || &bytes[..8] != PNG_MAGIC {
        return Err("grim output is not a valid PNG".to_string());
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(BrowserSnapshotResult {
        data_url: Some(format!("data:image/png;base64,{b64}")),
        width,
        height,
        backend: "hyprland_grim".to_string(),
        fallback_reason: None,
    })
}

pub trait BrowserChildDriver: Send + Sync {
    fn ensure_and_navigate(
        &self,
        url: &str,
        bounds: BrowserBounds,
        visible: bool,
    ) -> Result<(), String>;
    fn sync_bounds(&self, bounds: BrowserBounds) -> Result<(), String>;
    fn set_visible(&self, visible: bool) -> Result<(), String>;
    fn reload(&self) -> Result<(), String>;
    fn close(&self) -> Result<(), String>;
}

/// No-op driver for headless Rust unit tests (`cargo test`).
pub struct NoopBrowserChildDriver;

impl BrowserChildDriver for NoopBrowserChildDriver {
    fn ensure_and_navigate(
        &self,
        _url: &str,
        _bounds: BrowserBounds,
        _visible: bool,
    ) -> Result<(), String> {
        Ok(())
    }

    fn sync_bounds(&self, _bounds: BrowserBounds) -> Result<(), String> {
        Ok(())
    }

    fn set_visible(&self, _visible: bool) -> Result<(), String> {
        Ok(())
    }

    fn reload(&self) -> Result<(), String> {
        Ok(())
    }

    fn close(&self) -> Result<(), String> {
        Ok(())
    }
}

struct BrowserInternalState {
    initialized: bool,
    url: String,
    title: String,
    visible: bool,
    loading: bool,
    bounds: BrowserBounds,
    history: Vec<String>,
    history_index: usize,
}

impl Default for BrowserInternalState {
    fn default() -> Self {
        Self {
            initialized: false,
            url: DEFAULT_BROWSER_URL.to_string(),
            title: "Browser".to_string(),
            visible: false,
            loading: false,
            bounds: BrowserBounds::default(),
            history: Vec::new(),
            history_index: 0,
        }
    }
}

impl BrowserInternalState {
    fn to_public(&self) -> BrowserPanelState {
        BrowserPanelState {
            initialized: self.initialized,
            url: self.url.clone(),
            title: self.title.clone(),
            visible: self.visible,
            loading: self.loading,
            bounds: self.bounds,
            can_go_back: !self.history.is_empty() && self.history_index > 0,
            can_go_forward: !self.history.is_empty() && self.history_index + 1 < self.history.len(),
        }
    }

    fn push_history(&mut self, valid_url: String) {
        if self.history.is_empty() {
            self.history.push(valid_url);
            self.history_index = 0;
        } else if self.history[self.history_index] != valid_url {
            self.history.truncate(self.history_index + 1);
            self.history.push(valid_url);
            self.history_index = self.history.len() - 1;
        }
    }
}

fn sanitize_bounds(bounds: BrowserBounds) -> BrowserBounds {
    BrowserBounds {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width.max(1.0),
        height: bounds.height.max(1.0),
    }
}

pub struct BrowserPanelManager {
    state: Mutex<BrowserInternalState>,
}

impl Default for BrowserPanelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserPanelManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BrowserInternalState::default()),
        }
    }

    pub fn get_state(&self) -> Result<BrowserPanelState, String> {
        let guard = self
            .state
            .lock()
            .map_err(|_| "browser_panel mutex poisoned".to_string())?;
        Ok(guard.to_public())
    }

    pub fn navigate<D: BrowserChildDriver>(
        &self,
        driver: &D,
        raw_url: &str,
        bounds: Option<BrowserBounds>,
    ) -> Result<BrowserPanelState, String> {
        let valid_url = normalize_and_validate_browser_url(raw_url)?;

        let (current_bounds, current_visible) = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| "browser_panel mutex poisoned".to_string())?;
            if let Some(b) = bounds {
                guard.bounds = sanitize_bounds(b);
            }
            if !guard.initialized {
                guard.initialized = true;
                guard.visible = true;
            }
            guard.url = valid_url.clone();
            guard.push_history(valid_url.clone());
            (guard.bounds, guard.visible)
        };

        driver.ensure_and_navigate(&valid_url, current_bounds, current_visible)?;
        self.get_state()
    }

    pub fn sync_bounds<D: BrowserChildDriver>(
        &self,
        driver: &D,
        bounds: BrowserBounds,
    ) -> Result<BrowserPanelState, String> {
        let sanitized = sanitize_bounds(bounds);
        let initialized = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| "browser_panel mutex poisoned".to_string())?;
            guard.bounds = sanitized;
            guard.initialized
        };

        if initialized {
            driver.sync_bounds(sanitized)?;
        }
        self.get_state()
    }

    pub fn set_visible<D: BrowserChildDriver>(
        &self,
        driver: &D,
        visible: bool,
    ) -> Result<BrowserPanelState, String> {
        let initialized = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| "browser_panel mutex poisoned".to_string())?;
            guard.visible = visible;
            guard.initialized
        };

        if initialized {
            driver.set_visible(visible)?;
        }
        self.get_state()
    }

    pub fn go_back<D: BrowserChildDriver>(&self, driver: &D) -> Result<BrowserPanelState, String> {
        let target = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| "browser_panel mutex poisoned".to_string())?;
            if guard.history_index > 0 {
                guard.history_index -= 1;
                let url = guard.history[guard.history_index].clone();
                guard.url = url.clone();
                Some((url, guard.bounds, guard.visible))
            } else {
                None
            }
        };

        if let Some((url, bounds, visible)) = target {
            driver.ensure_and_navigate(&url, bounds, visible)?;
        }
        self.get_state()
    }

    pub fn go_forward<D: BrowserChildDriver>(&self, driver: &D) -> Result<BrowserPanelState, String> {
        let target = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| "browser_panel mutex poisoned".to_string())?;
            if !guard.history.is_empty() && guard.history_index + 1 < guard.history.len() {
                guard.history_index += 1;
                let url = guard.history[guard.history_index].clone();
                guard.url = url.clone();
                Some((url, guard.bounds, guard.visible))
            } else {
                None
            }
        };

        if let Some((url, bounds, visible)) = target {
            driver.ensure_and_navigate(&url, bounds, visible)?;
        }
        self.get_state()
    }

    pub fn reload<D: BrowserChildDriver>(&self, driver: &D) -> Result<BrowserPanelState, String> {
        let initialized = {
            let guard = self
                .state
                .lock()
                .map_err(|_| "browser_panel mutex poisoned".to_string())?;
            guard.initialized
        };

        if initialized {
            driver.reload()?;
        }
        self.get_state()
    }

    pub fn close<D: BrowserChildDriver>(&self, driver: &D) -> Result<BrowserPanelState, String> {
        let initialized = {
            let guard = self
                .state
                .lock()
                .map_err(|_| "browser_panel mutex poisoned".to_string())?;
            guard.initialized
        };

        if initialized {
            driver.close()?;
        }

        {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| "browser_panel mutex poisoned".to_string())?;
            guard.initialized = false;
            guard.visible = false;
            guard.loading = false;
        }
        self.get_state()
    }

    pub fn record_external_navigation(&self, url: String) {
        if !is_allowed_browser_url(&url) {
            return;
        }
        if let Ok(mut guard) = self.state.lock() {
            guard.url = url.clone();
            guard.push_history(url);
        }
    }

    pub fn record_title_changed(&self, title: String) {
        if let Ok(mut guard) = self.state.lock() {
            if !title.trim().is_empty() {
                guard.title = title;
            }
        }
    }

    pub fn record_loading(&self, loading: bool) {
        if let Ok(mut guard) = self.state.lock() {
            guard.loading = loading;
        }
    }

    pub fn capture_snapshot<D: BrowserChildDriver>(
        &self,
        driver: &D,
        bounds: Option<BrowserBounds>,
    ) -> Result<BrowserSnapshotResult, String> {
        let target_bounds = match bounds {
            Some(b) => sanitize_bounds(b),
            None => {
                let guard = self
                    .state
                    .lock()
                    .map_err(|_| "browser_panel mutex poisoned".to_string())?;
                guard.bounds
            }
        };

        let snap = capture_region_snapshot(&target_bounds)?;
        let _ = self.set_visible(driver, false);
        Ok(snap)
    }
}

#[cfg(feature = "desktop")]
pub mod desktop_driver {
    use super::*;
    use crate::flow_bridge::resolve_webview_profile_dir;
    use crate::types::ImageGenerationConfig;
    use std::sync::Arc;
    use tauri::{
        webview::{PageLoadEvent, WebviewBuilder},
        AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Url,
        Webview, WebviewUrl,
    };

    pub struct TauriChildWebviewDriver {
        pub app: AppHandle,
        pub manager: Arc<BrowserPanelManager>,
    }

    impl BrowserChildDriver for TauriChildWebviewDriver {
        fn ensure_and_navigate(
            &self,
            url: &str,
            bounds: BrowserBounds,
            visible: bool,
        ) -> Result<(), String> {
            let parsed_url: Url = url
                .parse()
                .map_err(|e| format!("invalid browser URL '{url}': {e}"))?;

            if let Some(webview) = self.app.get_webview(BROWSER_WEBVIEW_LABEL) {
                webview
                    .set_bounds(Rect {
                        position: Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
                        size: Size::Logical(LogicalSize::new(
                            bounds.width.max(1.0),
                            bounds.height.max(1.0),
                        )),
                    })
                    .map_err(|e| format!("failed to update browser webview bounds: {e}"))?;

                webview
                    .navigate(parsed_url)
                    .map_err(|e| format!("failed to navigate browser webview: {e}"))?;

                if visible {
                    webview
                        .show()
                        .map_err(|e| format!("failed to show browser webview: {e}"))?;
                } else {
                    webview
                        .hide()
                        .map_err(|e| format!("failed to hide browser webview: {e}"))?;
                }
                return Ok(());
            }

            // CRITICAL: always use `app.get_window("main")`, never `get_webview_window("main")`.
            let main_window = self
                .app
                .get_window("main")
                .ok_or_else(|| "main window not found".to_string())?;

            let profile_dir = resolve_webview_profile_dir(&ImageGenerationConfig::default())?;

            let app_for_load = self.app.clone();
            let mgr_for_load = Arc::clone(&self.manager);
            let app_for_title = self.app.clone();
            let mgr_for_title = Arc::clone(&self.manager);

            let builder =
                WebviewBuilder::new(BROWSER_WEBVIEW_LABEL, WebviewUrl::External(parsed_url))
                    .data_directory(profile_dir)
                    .focused(false)
                    .on_navigation(move |nav_url: &Url| -> bool {
                        is_allowed_browser_url(nav_url.as_str())
                    })
                    .on_page_load(move |_webview, payload| {
                        let loading = matches!(payload.event(), PageLoadEvent::Started);
                        mgr_for_load.record_loading(loading);
                        if !loading {
                            mgr_for_load
                                .record_external_navigation(payload.url().as_str().to_string());
                        }
                        if let Ok(state) = mgr_for_load.get_state() {
                            let _ = app_for_load.emit("browser://state", &state);
                        }
                    })
                    .on_document_title_changed(move |_webview, title: String| {
                        mgr_for_title.record_title_changed(title);
                        if let Ok(state) = mgr_for_title.get_state() {
                            let _ = app_for_title.emit("browser://state", &state);
                        }
                    });

            let webview: Webview = main_window
                .add_child(
                    builder,
                    LogicalPosition::new(bounds.x, bounds.y),
                    LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
                )
                .map_err(|e| format!("failed to create browser child webview: {e}"))?;

            if !visible {
                webview
                    .hide()
                    .map_err(|e| format!("failed to hide browser webview: {e}"))?;
            }

            Ok(())
        }

        fn sync_bounds(&self, bounds: BrowserBounds) -> Result<(), String> {
            let Some(webview) = self.app.get_webview(BROWSER_WEBVIEW_LABEL) else {
                return Ok(());
            };
            webview
                .set_bounds(Rect {
                    position: Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
                    size: Size::Logical(LogicalSize::new(
                        bounds.width.max(1.0),
                        bounds.height.max(1.0),
                    )),
                })
                .map_err(|e| format!("failed to update browser webview bounds: {e}"))
        }

        fn set_visible(&self, visible: bool) -> Result<(), String> {
            let Some(webview) = self.app.get_webview(BROWSER_WEBVIEW_LABEL) else {
                return Ok(());
            };
            if visible {
                webview
                    .show()
                    .map_err(|e| format!("failed to show browser webview: {e}"))
            } else {
                webview
                    .hide()
                    .map_err(|e| format!("failed to hide browser webview: {e}"))
            }
        }

        fn reload(&self) -> Result<(), String> {
            let Some(webview) = self.app.get_webview(BROWSER_WEBVIEW_LABEL) else {
                return Ok(());
            };
            webview
                .reload()
                .map_err(|e| format!("failed to reload browser webview: {e}"))
        }

        fn close(&self) -> Result<(), String> {
            let Some(webview) = self.app.get_webview(BROWSER_WEBVIEW_LABEL) else {
                return Ok(());
            };
            webview
                .close()
                .map_err(|e| format!("failed to close browser webview: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_security_allows_only_http_and_https() {
        assert!(is_allowed_browser_url("https://labs.google/fx/tools/flow"));
        assert!(is_allowed_browser_url("http://localhost:5173/test"));
        assert!(is_allowed_browser_url("HTTPS://EXAMPLE.COM/path?q=1"));

        assert!(!is_allowed_browser_url(""));
        assert!(!is_allowed_browser_url("   "));
        assert!(!is_allowed_browser_url("file:///etc/passwd"));
        assert!(!is_allowed_browser_url("javascript:alert(1)"));
        assert!(!is_allowed_browser_url("data:text/html,<script>alert(1)</script>"));
        assert!(!is_allowed_browser_url("vbscript:msgbox(1)"));
        assert!(!is_allowed_browser_url("tauri://localhost/index.html"));
        assert!(!is_allowed_browser_url("ipc://localhost"));
        assert!(!is_allowed_browser_url("asset://localhost/foo.png"));
        assert!(!is_allowed_browser_url("about:blank"));
        assert!(!is_allowed_browser_url("https://"));
        assert!(!is_allowed_browser_url("https://example.com/with space"));
    }

    #[test]
    fn normalize_url_handles_schemes_and_defaults() {
        assert_eq!(
            normalize_and_validate_browser_url("labs.google/fx/tools/flow").unwrap(),
            "https://labs.google/fx/tools/flow"
        );
        assert_eq!(
            normalize_and_validate_browser_url("localhost:5173").unwrap(),
            "http://localhost:5173"
        );
        assert_eq!(
            normalize_and_validate_browser_url("127.0.0.1:8080/api").unwrap(),
            "http://127.0.0.1:8080/api"
        );
        assert_eq!(
            normalize_and_validate_browser_url("  https://godotengine.org  ").unwrap(),
            "https://godotengine.org"
        );

        assert!(normalize_and_validate_browser_url("").is_err());
        assert!(normalize_and_validate_browser_url("file:///etc/passwd").is_err());
        assert!(normalize_and_validate_browser_url("javascript:alert(1)").is_err());
        assert!(normalize_and_validate_browser_url("ftp://example.com/file").is_err());
    }

    #[test]
    fn compute_grim_region_applies_window_offset_and_hidpi_scale() {
        let active_win = r#"{"at":[100,50],"size":[1440,900],"monitor":1}"#;
        let monitors = r#"[{"id":0,"scale":1.0},{"id":1,"scale":1.5}]"#;
        let bounds = BrowserBounds {
            x: 200.0,
            y: 80.0,
            width: 800.0,
            height: 600.0,
        };

        let region = compute_grim_region_for_bounds(active_win, monitors, &bounds).unwrap();
        // (100+200)*1.5 = 450, (50+80)*1.5 = 195, 800*1.5 = 1200, 600*1.5 = 900
        assert_eq!(region, "450,195 1200x900");
    }

    #[test]
    fn browser_panel_manager_navigation_history_bounds_and_snapshot() {
        let mgr = BrowserPanelManager::new();
        let driver = NoopBrowserChildDriver;

        let init_state = mgr.get_state().unwrap();
        assert!(!init_state.initialized);
        assert!(!init_state.visible);
        assert!(!init_state.can_go_back);
        assert!(!init_state.can_go_forward);

        let s1 = mgr
            .navigate(
                &driver,
                "labs.google/fx/tools/flow",
                Some(BrowserBounds {
                    x: 10.0,
                    y: 20.0,
                    width: 640.0,
                    height: 480.0,
                }),
            )
            .unwrap();
        assert!(s1.initialized);
        assert!(s1.visible);
        assert_eq!(s1.url, "https://labs.google/fx/tools/flow");
        assert!(!s1.can_go_back);
        assert!(!s1.can_go_forward);

        let s2 = mgr.navigate(&driver, "https://godotengine.org", None).unwrap();
        assert_eq!(s2.url, "https://godotengine.org");
        assert!(s2.can_go_back);
        assert!(!s2.can_go_forward);

        let back = mgr.go_back(&driver).unwrap();
        assert_eq!(back.url, "https://labs.google/fx/tools/flow");
        assert!(!back.can_go_back);
        assert!(back.can_go_forward);

        let fwd = mgr.go_forward(&driver).unwrap();
        assert_eq!(fwd.url, "https://godotengine.org");
        assert!(fwd.can_go_back);
        assert!(!fwd.can_go_forward);

        let synced = mgr
            .sync_bounds(
                &driver,
                BrowserBounds {
                    x: 30.0,
                    y: 40.0,
                    width: 0.0,
                    height: -5.0,
                },
            )
            .unwrap();
        assert_eq!(synced.bounds.width, 1.0);
        assert_eq!(synced.bounds.height, 1.0);

        let snap = mgr.capture_snapshot(&driver, None).unwrap();
        assert_eq!(snap.width, 1);
        assert_eq!(snap.height, 1);
        assert!(!mgr.get_state().unwrap().visible);

        let closed = mgr.close(&driver).unwrap();
        assert!(!closed.initialized);
        assert!(!closed.visible);
    }
}
