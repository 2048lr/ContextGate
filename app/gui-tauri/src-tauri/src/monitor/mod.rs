use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

pub const MODEL_PRICING: &[(&str, f64, f64)] = &[
    ("gpt-4o-mini", 0.15 / 1_000_000.0, 0.6 / 1_000_000.0),
    ("gpt-4o", 2.5 / 1_000_000.0, 10.0 / 1_000_000.0),
    ("gpt-4-32k", 60.0 / 1_000_000.0, 120.0 / 1_000_000.0),
    ("gpt-4-turbo", 10.0 / 1_000_000.0, 30.0 / 1_000_000.0),
    ("gpt-4", 30.0 / 1_000_000.0, 60.0 / 1_000_000.0),
    ("gpt-3.5-turbo", 0.5 / 1_000_000.0, 1.5 / 1_000_000.0),
    ("o1-pro", 150.0 / 1_000_000.0, 600.0 / 1_000_000.0),
    ("o1-mini", 3.0 / 1_000_000.0, 12.0 / 1_000_000.0),
    ("o1", 15.0 / 1_000_000.0, 60.0 / 1_000_000.0),
    ("o3-mini", 1.1 / 1_000_000.0, 4.4 / 1_000_000.0),
    ("claude-3.5-sonnet", 3.0 / 1_000_000.0, 15.0 / 1_000_000.0),
    ("claude-3.5-haiku", 0.8 / 1_000_000.0, 4.0 / 1_000_000.0),
    ("claude-3-opus", 15.0 / 1_000_000.0, 75.0 / 1_000_000.0),
    ("claude-3-sonnet", 3.0 / 1_000_000.0, 15.0 / 1_000_000.0),
    ("claude-3-haiku", 0.25 / 1_000_000.0, 1.25 / 1_000_000.0),
    ("deepseek-chat", 0.27 / 1_000_000.0, 1.1 / 1_000_000.0),
    ("deepseek-reasoner", 0.55 / 1_000_000.0, 2.19 / 1_000_000.0),
    ("glm-4", 0.1 / 1_000_000.0, 0.1 / 1_000_000.0),
    ("glm-4-plus", 0.5 / 1_000_000.0, 0.5 / 1_000_000.0),
    ("glm-4-flash", 0.01 / 1_000_000.0, 0.01 / 1_000_000.0),
    ("qwen-turbo", 0.3 / 1_000_000.0, 0.6 / 1_000_000.0),
    ("qwen-plus", 0.8 / 1_000_000.0, 2.0 / 1_000_000.0),
    ("qwen-max", 2.4 / 1_000_000.0, 9.6 / 1_000_000.0),
    ("gemini-1.5-pro", 1.25 / 1_000_000.0, 5.0 / 1_000_000.0),
    ("gemini-1.5-flash", 0.075 / 1_000_000.0, 0.3 / 1_000_000.0),
    ("gemini-2.0-flash", 0.1 / 1_000_000.0, 0.4 / 1_000_000.0),
];

pub fn calculate_cost(model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    if model.is_empty() {
        return 0.0;
    }
    let lower = model.to_lowercase();
    for (prefix, input_price, output_price) in MODEL_PRICING {
        if lower.starts_with(prefix) {
            return (input_tokens as f64) * input_price + (output_tokens as f64) * output_price;
        }
    }
    0.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestData {
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost: Option<f64>,
    pub currency: String,
    pub cached: bool,
    pub response_time: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatsSummary {
    pub total: TotalStats,
    pub today: DailyStats,
    pub month: MonthlyStats,
    pub by_provider: Vec<ProviderStats>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TotalStats {
    pub request_count: u64,
    pub total_tokens: u64,
    pub total_cost: f64,
    pub cache_hits: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailyStats {
    pub requests: u64,
    pub tokens: u64,
    pub cost: f64,
    pub cache_hits: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonthlyStats {
    pub requests: u64,
    pub tokens: u64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderStats {
    pub provider: String,
    pub requests: u64,
    pub tokens: u64,
    pub cost: f64,
}

pub struct TokenMonitor {
    db: Mutex<Connection>,
}

impl TokenMonitor {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let parent = Path::new(db_path).parent();
        if let Some(dir) = parent {
            if !dir.exists() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
        }

        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        let monitor = Self {
            db: Mutex::new(conn),
        };
        monitor.create_tables()?;
        Ok(monitor)
    }

    fn create_tables(&self) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT DEFAULT (datetime('now')),
                provider TEXT NOT NULL,
                model TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                total_tokens INTEGER,
                cost REAL,
                currency TEXT DEFAULT 'USD',
                cached INTEGER DEFAULT 0,
                response_time INTEGER
            );
            CREATE TABLE IF NOT EXISTS daily_stats (
                date TEXT PRIMARY KEY,
                total_requests INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                total_cost REAL DEFAULT 0,
                cache_hits INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS monthly_stats (
                month TEXT PRIMARY KEY,
                total_requests INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                total_cost REAL DEFAULT 0
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_request(&self, data: &RequestData) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        let total_tokens = data.input_tokens + data.output_tokens;
        let cost = data
            .cost
            .unwrap_or_else(|| calculate_cost(&data.model, data.input_tokens, data.output_tokens));

        db.execute(
            "INSERT INTO requests (provider, model, input_tokens, output_tokens, total_tokens, cost, currency, cached, response_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                data.provider,
                data.model,
                data.input_tokens,
                data.output_tokens,
                total_tokens,
                cost,
                data.currency,
                data.cached as i32,
                data.response_time,
            ],
        )
        .map_err(|e| e.to_string())?;

        let today = today_date();
        db.execute(
            "INSERT INTO daily_stats (date, total_requests, total_tokens, total_cost, cache_hits)
             VALUES (?1, 1, ?2, ?3, ?4)
             ON CONFLICT(date) DO UPDATE SET
               total_requests = total_requests + 1,
               total_tokens = total_tokens + ?2,
               total_cost = total_cost + ?3,
               cache_hits = cache_hits + ?4",
            params![today, total_tokens, cost, data.cached as i32],
        )
        .map_err(|e| e.to_string())?;

        let month = &today[..7];
        db.execute(
            "INSERT INTO monthly_stats (month, total_requests, total_tokens, total_cost)
             VALUES (?1, 1, ?2, ?3)
             ON CONFLICT(month) DO UPDATE SET
               total_requests = total_requests + 1,
               total_tokens = total_tokens + ?2,
               total_cost = total_cost + ?3",
            params![month, total_tokens, cost],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_summary(&self) -> Result<StatsSummary, String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;

        let request_count: u64 = db
            .query_row("SELECT COUNT(*) FROM requests", [], |row| row.get(0))
            .unwrap_or(0);
        let total_tokens: u64 = db
            .query_row("SELECT COALESCE(SUM(total_tokens), 0) FROM requests", [], |row| row.get(0))
            .unwrap_or(0);
        let total_cost: f64 = db
            .query_row("SELECT COALESCE(SUM(cost), 0) FROM requests", [], |row| row.get(0))
            .unwrap_or(0.0);
        let cache_hits: u64 = db
            .query_row("SELECT COALESCE(SUM(cache_hits), 0) FROM daily_stats", [], |row| row.get(0))
            .unwrap_or(0);

        let today = today_date();
        let today_data: (u64, u64, f64, u64) = db
            .query_row(
                "SELECT total_requests, total_tokens, total_cost, cache_hits FROM daily_stats WHERE date = ?1",
                params![today],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap_or((0, 0, 0.0, 0));

        let month = &today[..7];
        let month_data: (u64, u64, f64) = db
            .query_row(
                "SELECT total_requests, total_tokens, total_cost FROM monthly_stats WHERE month = ?1",
                params![month],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap_or((0, 0, 0.0));

        let mut provider_stmt = db
            .prepare("SELECT provider, COUNT(*), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost), 0) FROM requests GROUP BY provider")
            .map_err(|e| e.to_string())?;
        let by_provider: Vec<ProviderStats> = provider_stmt
            .query_map([], |row| {
                Ok(ProviderStats {
                    provider: row.get(0)?,
                    requests: row.get(1)?,
                    tokens: row.get(2)?,
                    cost: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(StatsSummary {
            total: TotalStats {
                request_count,
                total_tokens,
                total_cost,
                cache_hits,
            },
            today: DailyStats {
                requests: today_data.0,
                tokens: today_data.1,
                cost: today_data.2,
                cache_hits: today_data.3,
            },
            month: MonthlyStats {
                requests: month_data.0,
                tokens: month_data.1,
                cost: month_data.2,
            },
            by_provider,
        })
    }

    pub fn reset(&self) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        db.execute_batch("DELETE FROM requests; DELETE FROM daily_stats; DELETE FROM monthly_stats;")
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn today_date() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let days = secs / 86400;
    let year = 1970 + (days / 365) as i32;
    let day_of_year = (days % 365) as i32;
    let month_days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    let mut remaining = day_of_year;
    for &md in &month_days {
        if remaining < md {
            break;
        }
        remaining -= md;
        month += 1;
    }
    let day = remaining + 1;
    format!("{:04}-{:02}-{:02}", year, month, day)
}
