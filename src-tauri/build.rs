fn main() {
    println!("cargo:rerun-if-env-changed=GAME_HUB_CHANNEL");
    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
    {
        if output.status.success() {
            let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !sha.is_empty() {
                println!("cargo:rustc-env=HUB_BUILD_COMMIT={sha}");
            }
        }
    }
    let channel = std::env::var("GAME_HUB_CHANNEL").unwrap_or_else(|_| "local".to_string());
    println!("cargo:rustc-env=HUB_BUILD_CHANNEL={channel}");

    #[cfg(feature = "desktop")]
    tauri_build::build();
}
