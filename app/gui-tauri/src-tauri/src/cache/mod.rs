use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub value: serde_json::Value,
    pub size: usize,
    pub last_access: u64,
    pub created_at: u64,
}

pub struct LruCache {
    cache: Mutex<HashMap<String, CacheEntry>>,
    max_size: usize,
    max_memory: usize,
    current_memory: Mutex<usize>,
}

impl LruCache {
    pub fn new(max_size: usize, max_memory_mb: usize) -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            max_size,
            max_memory: max_memory_mb * 1024 * 1024,
            current_memory: Mutex::new(0),
        }
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    pub fn get(&self, key: &str) -> Option<serde_json::Value> {
        let mut cache = self.cache.lock();
        if let Some(entry) = cache.get_mut(key) {
            entry.last_access = Self::now_ms();
            Some(entry.value.clone())
        } else {
            None
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.cache.lock().contains_key(key)
    }

    pub fn set(&self, key: &str, value: serde_json::Value) {
        let serialized = serde_json::to_string(&value).unwrap_or_default();
        let entry_size = serialized.len();

        let mut cache = self.cache.lock();
        let mut current_memory = self.current_memory.lock();

        if let Some(old) = cache.get(key) {
            *current_memory -= old.size;
        }

        while cache.len() >= self.max_size && !cache.contains_key(key) {
            Self::evict_one(&mut cache, &mut current_memory);
        }

        while *current_memory + entry_size > self.max_memory && !cache.is_empty() {
            if cache.contains_key(key) {
                break;
            }
            Self::evict_one(&mut cache, &mut current_memory);
        }

        if let Some(old) = cache.get(key) {
            *current_memory -= old.size;
        }

        *current_memory += entry_size;
        cache.insert(
            key.to_string(),
            CacheEntry {
                value,
                size: entry_size,
                last_access: Self::now_ms(),
                created_at: Self::now_ms(),
            },
        );
    }

    fn evict_one(
        cache: &mut HashMap<String, CacheEntry>,
        current_memory: &mut usize,
    ) {
        if let Some(evict_key) = cache
            .iter()
            .min_by_key(|(_, v)| v.last_access)
            .map(|(k, _)| k.clone())
        {
            if let Some(removed) = cache.remove(&evict_key) {
                *current_memory -= removed.size;
            }
        }
    }

    pub fn remove(&self, key: &str) -> Option<serde_json::Value> {
        let mut cache = self.cache.lock();
        let mut current_memory = self.current_memory.lock();
        if let Some(entry) = cache.remove(key) {
            *current_memory -= entry.size;
            Some(entry.value)
        } else {
            None
        }
    }

    pub fn clear(&self) {
        let mut cache = self.cache.lock();
        let mut current_memory = self.current_memory.lock();
        cache.clear();
        *current_memory = 0;
    }

    pub fn len(&self) -> usize {
        self.cache.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.cache.lock().is_empty()
    }

    pub fn memory_usage(&self) -> usize {
        *self.current_memory.lock()
    }
}

pub type SharedLruCache = std::sync::Arc<LruCache>;
