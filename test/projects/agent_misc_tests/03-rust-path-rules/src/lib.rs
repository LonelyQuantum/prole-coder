pub fn normalize_workspace_path(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.contains("..") {
        return None;
    }

    Some(trimmed.replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::normalize_workspace_path;

    #[test]
    fn normalizes_common_relative_paths() {
        assert_eq!(
            normalize_workspace_path("./src//lib.rs"),
            Some("src/lib.rs".to_string())
        );
        assert_eq!(
            normalize_workspace_path("notes\\daily\\plan.md"),
            Some("notes/daily/plan.md".to_string())
        );
    }

    #[test]
    fn resolves_safe_parent_segments() {
        assert_eq!(
            normalize_workspace_path("src/generated/../lib.rs"),
            Some("src/lib.rs".to_string())
        );
    }

    #[test]
    fn rejects_paths_that_escape_workspace() {
        assert_eq!(normalize_workspace_path("../secret.txt"), None);
        assert_eq!(normalize_workspace_path("src/../../secret.txt"), None);
    }

    #[test]
    fn rejects_absolute_and_platform_specific_paths() {
        assert_eq!(normalize_workspace_path("/tmp/file.txt"), None);
        assert_eq!(normalize_workspace_path("C:\\Users\\name\\file.txt"), None);
        assert_eq!(normalize_workspace_path("\\\\server\\share\\file.txt"), None);
    }

    #[test]
    fn rejects_empty_and_nul_paths() {
        assert_eq!(normalize_workspace_path("   "), None);
        assert_eq!(normalize_workspace_path("src/\0file.rs"), None);
    }
}
