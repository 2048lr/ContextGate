pub const DEFAULT_EXTENSIONS: &[&str] = &[
    ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rs",
    ".c", ".cpp", ".h", ".hpp", ".md", ".txt", ".json", ".yaml",
    ".yml", ".toml", ".xml", ".csv", ".sql", ".sh", ".bash",
    ".css", ".scss", ".less", ".html", ".vue", ".svelte",
];

pub const BINARY_EXTENSIONS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".exe", ".dll", ".so", ".dylib", ".bin",
    ".db", ".sqlite", ".sqlite3",
    ".pyc", ".pyo", ".class", ".o", ".obj",
    ".lock", ".log",
];

pub const EXCLUDE_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", ".hg", "__pycache__",
    ".tox", ".venv", "venv", "env", ".env",
    "dist", "build", ".next", ".nuxt", ".output",
    "coverage", ".nyc_output", ".pytest_cache",
    ".idea", ".vscode", ".vs",
    "target", "bin", "obj", ".gradle",
    "bower_components", "vendor",
    ".turbo", ".cache", "tmp", "temp",
];

pub fn is_binary_extension(ext: &str) -> bool {
    BINARY_EXTENSIONS.contains(&ext)
}

pub fn get_language(ext: &str) -> Option<&'static str> {
    match ext {
        ".js" | ".jsx" | ".mjs" | ".cjs" => Some("javascript"),
        ".ts" | ".tsx" | ".mts" => Some("typescript"),
        ".py" => Some("python"),
        ".go" => Some("go"),
        ".java" => Some("java"),
        ".rs" => Some("rust"),
        ".c" | ".h" => Some("c"),
        ".cpp" | ".hpp" => Some("cpp"),
        _ => None,
    }
}
