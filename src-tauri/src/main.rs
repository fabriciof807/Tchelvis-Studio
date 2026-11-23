#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use game_hub_lib::workspace;
use std::path::Path;

fn main() {
    let defaults_dir = Path::new("defaults");
    let global_config = workspace::ensure_default_config(defaults_dir.exists().then_some(defaults_dir))
        .unwrap_or_default();

    if global_config.webkitgtk.disable_dmabuf_renderer {
        // SAFETY: called at startup before spawning any worker threads or WebKitGTK.
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    #[cfg(feature = "desktop")]
    {
        game_hub_lib::run_desktop(global_config);
    }

    #[cfg(not(feature = "desktop"))]
    {
        let _ = global_config;
        eprintln!("game-hub built without 'desktop' feature; run with `--features desktop` for Tauri GUI.");
    }
}
