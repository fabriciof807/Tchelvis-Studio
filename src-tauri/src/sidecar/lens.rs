use crate::types::LensInfo;
use crate::workspace::canonicalize_in_workspace;
use std::fs;
use std::path::Path;

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

#[cfg(test)]
mod tests {
    use super::*;
    
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
}
