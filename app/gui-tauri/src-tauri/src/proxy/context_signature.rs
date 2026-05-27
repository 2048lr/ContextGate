use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const CONTEXT_HASH_FILE: &str = ".context_hash";

#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextSignature {
    pub main_hash: String,
    pub combined_hash: String,
    pub file_hashes: HashMap<String, String>,
    pub file_count: usize,
    pub files: Vec<String>,
    pub file: String,
}

pub fn compute_file_hash(file_path: &str) -> Option<String> {
    let content = fs::read(file_path).ok()?;
    let mut hasher = Sha1::new();
    hasher.update(&content);
    Some(hex::encode(hasher.finalize()))
}

pub fn load_saved_context_hash(context_dir: &str) -> Option<String> {
    let hash_file = PathBuf::from(context_dir).join(CONTEXT_HASH_FILE);
    fs::read_to_string(hash_file).ok().map(|s| s.trim().to_string())
}

pub fn save_context_hash(context_dir: &str, hash: &str) {
    let hash_file = PathBuf::from(context_dir).join(CONTEXT_HASH_FILE);
    let _ = fs::write(hash_file, hash);
}

pub fn compute_context_signature(
    context_file: &str,
    project_root: Option<&str>,
) -> Option<ContextSignature> {
    let content = fs::read_to_string(context_file).ok()?;
    let mut hasher = Sha1::new();
    hasher.update(&content);
    let main_hash = hex::encode(hasher.finalize());

    let mut files = Vec::new();
    for line in content.lines() {
        if let Some(file_match) = line.strip_prefix("# File: ") {
            files.push(file_match.trim().to_string());
        }
    }

    let mut file_hashes = HashMap::new();
    if let Some(root) = project_root {
        for file_rel_path in &files {
            let abs_path = PathBuf::from(root).join(file_rel_path);
            if let Some(hash) = compute_file_hash(abs_path.to_str().unwrap_or("")) {
                file_hashes.insert(file_rel_path.clone(), hash);
            }
        }
    }

    let combined_input: String = file_hashes
        .iter()
        .map(|(k, v)| format!("{}:{}", k, v))
        .collect::<Vec<_>>()
        .join(",");
    let mut hasher = Sha1::new();
    hasher.update(combined_input.as_bytes());
    let combined_hash = hex::encode(hasher.finalize());

    Some(ContextSignature {
        main_hash,
        combined_hash,
        file_hashes,
        file_count: files.len(),
        files,
        file: context_file.to_string(),
    })
}

pub fn check_context_changed(
    current: Option<&ContextSignature>,
    context_file: &str,
    project_root: Option<&str>,
) -> bool {
    let new_sig = match compute_context_signature(context_file, project_root) {
        Some(s) => s,
        None => return false,
    };
    match current {
        None => true,
        Some(old) => {
            new_sig.combined_hash != old.combined_hash || new_sig.main_hash != old.main_hash
        }
    }
}

pub fn get_context_hash(signature: Option<&ContextSignature>) -> String {
    match signature {
        Some(sig) => {
            if !sig.combined_hash.is_empty() {
                sig.combined_hash.clone()
            } else {
                sig.main_hash.clone()
            }
        }
        None => "none".to_string(),
    }
}
