pub mod constants;

use crate::config::AppConfig;
use constants::*;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub struct CodeScanner {
    root_dir: PathBuf,
    max_file_size: u64,
    include_extensions: HashSet<String>,
    exclude_dirs: HashSet<String>,
}

impl CodeScanner {
    pub fn new(root_dir: &str, config: &AppConfig) -> Self {
        let mut include_extensions: HashSet<String> = config
            .scanner
            .include_extensions
            .iter()
            .cloned()
            .collect();
        if include_extensions.is_empty() {
            include_extensions = DEFAULT_EXTENSIONS.iter().map(|s| s.to_string()).collect();
        }

        Self {
            root_dir: PathBuf::from(root_dir),
            max_file_size: config.scanner.max_file_size,
            include_extensions,
            exclude_dirs: EXCLUDE_DIRS.iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn scan(&self) -> Vec<String> {
        let mut files = Vec::new();
        self.walk_dir(&self.root_dir, &mut files);
        files.sort();
        files
    }

    fn walk_dir(&self, dir: &Path, files: &mut Vec<String>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let full_path = entry.path();

                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_dir() {
                        if self.exclude_dirs.contains(&name) || name.starts_with('.') {
                            continue;
                        }
                        self.walk_dir(&full_path, files);
                    } else if file_type.is_file() {
                        let ext = full_path
                            .extension()
                            .map(|e| format!(".{}", e.to_string_lossy()))
                            .unwrap_or_default();
                        if self.include_extensions.contains(&ext) {
                            if let Ok(metadata) = fs::metadata(&full_path) {
                                if metadata.len() <= self.max_file_size {
                                    if let Ok(relative) = full_path.strip_prefix(&self.root_dir) {
                                        files.push(relative.to_string_lossy().to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn build_context(&self, output_path: Option<&str>) -> Result<BuildContextResult, String> {
        let files = self.scan();
        let out = output_path
            .map(PathBuf::from)
            .unwrap_or_else(|| self.root_dir.join("full_context.txt"));

        let mut total_chars = 0usize;
        let mut lines: Vec<String> = Vec::new();

        let header = format!(
            "# ContextGate Generated Context File\n# Project: {}\n# Generated: {}\n# Files: {}\n\n",
            self.root_dir.display(),
            now_iso(),
            files.len()
        );
        total_chars += header.len();
        lines.push(header);

        for rel_path in &files {
            let abs_path = self.root_dir.join(rel_path);
            match fs::read_to_string(&abs_path) {
                Ok(content) => {
                    let file_header = format!(
                        "\n# ============================================================\n# File: {}\n# ============================================================\n",
                        rel_path
                    );
                    total_chars += file_header.len() + content.len();
                    lines.push(file_header);
                    lines.push(content);
                }
                Err(e) => {
                    let err_msg = format!("\n# File: {} (ERROR: {})\n", rel_path, e);
                    total_chars += err_msg.len();
                    lines.push(err_msg);
                }
            }
        }

        let full_content = lines.join("");
        fs::write(&out, &full_content).map_err(|e| e.to_string())?;

        let estimated_tokens = (total_chars as f64 / 4.0).ceil() as u64;

        Ok(BuildContextResult {
            file_count: files.len(),
            total_chars,
            estimated_tokens,
            output_path: out.to_string_lossy().to_string(),
        })
    }
}

fn now_iso() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let days = secs / 86400;
    let remaining = secs % 86400;
    let hours = remaining / 3600;
    let minutes = (remaining % 3600) / 60;
    let seconds = remaining % 60;

    let year = 1970 + (days / 365);
    let day_of_year = days % 365;
    let month_days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0;
    let mut remaining_days = day_of_year;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining_days < md {
            month = i + 1;
            break;
        }
        remaining_days -= md;
    }
    let day = remaining_days + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BuildContextResult {
    pub file_count: usize,
    pub total_chars: usize,
    pub estimated_tokens: u64,
    pub output_path: String,
}
