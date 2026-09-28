const { version: VERSION } = require('../../package.json')

const DEFAULT_PROXY_HOST = '127.0.0.1'
const DEFAULT_PROXY_PORT = 12306
// 请求体上限：Express 默认 100KB 会让带上下文的请求直接 413
const DEFAULT_MAX_BODY_SIZE = '32mb'

// FIX-07：流式可靠性默认值
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60000
const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = 0

// FIX-08：重试 / 降级 / 限流默认值
const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504]
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 500
const DEFAULT_RETRY_MAX_DELAY_MS = 8000
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30000
const DEFAULT_MAX_CONCURRENCY = 32
const DEFAULT_MAX_QUEUE = 64
const DEFAULT_QUEUE_TIMEOUT_MS = 30000
const DEFAULT_IDEMPOTENCY_HEADER = 'Idempotency-Key'

// FIX-10：Prompt Caching 默认值
// OpenAI 官方指南：最小可缓存前缀 1,024 token，低于该长度不会命中前缀缓存。
const DEFAULT_MIN_CACHEABLE_PREFIX_TOKENS = 1024

// FIX-09：持久化缓存默认值
const DEFAULT_CACHE_MAX_DISK_MB = 256
const DEFAULT_CACHE_PERSIST_MAX_ENTRY_BYTES = 262144

// FIX-12：数据保留默认值
const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_REQUEST_LOG_RETENTION_DAYS = 30
const DEFAULT_REQUEST_LOG_MAX_ENTRIES = 20000

const DEFAULT_EXTENSIONS = [
  '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.md', '.txt', '.json', '.yaml',
  '.yml', '.toml', '.xml', '.csv', '.sql', '.sh', '.bash',
  '.css', '.scss', '.less', '.html', '.vue', '.svelte'
]

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.db', '.sqlite', '.sqlite3',
  '.pyc', '.pyo', '.class', '.o', '.obj',
  '.lock', '.log'
])

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__',
  '.tox', '.venv', 'venv', 'env', '.env',
  'dist', 'build', '.next', '.nuxt', '.output',
  'coverage', '.nyc_output', '.pytest_cache',
  '.idea', '.vscode', '.vs',
  'target', 'bin', 'obj', '.gradle',
  'bower_components', 'vendor',
  '.turbo', '.cache', 'tmp', 'temp'
])

module.exports = {
  VERSION, DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT, DEFAULT_MAX_BODY_SIZE,
  DEFAULT_EXTENSIONS, BINARY_EXTENSIONS, EXCLUDE_DIRS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_STREAM_TOTAL_TIMEOUT_MS,
  DEFAULT_RETRY_STATUSES, DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS, DEFAULT_CIRCUIT_FAILURE_THRESHOLD, DEFAULT_CIRCUIT_COOLDOWN_MS,
  DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_QUEUE, DEFAULT_QUEUE_TIMEOUT_MS, DEFAULT_IDEMPOTENCY_HEADER,
  DEFAULT_MIN_CACHEABLE_PREFIX_TOKENS,
  DEFAULT_CACHE_MAX_DISK_MB, DEFAULT_CACHE_PERSIST_MAX_ENTRY_BYTES,
  DEFAULT_RETENTION_DAYS, DEFAULT_REQUEST_LOG_RETENTION_DAYS, DEFAULT_REQUEST_LOG_MAX_ENTRIES,
}
