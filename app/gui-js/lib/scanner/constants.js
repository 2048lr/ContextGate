const DEFAULT_EXTENSIONS = [
  '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.md', '.txt', '.json', '.yaml',
  '.yml', '.toml', '.xml', '.csv', '.sql', '.sh', '.bash',
  '.css', '.scss', '.less', '.html', '.vue', '.svelte',
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
  '.lock', '.log',
])

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__',
  '.tox', '.venv', 'venv', 'env', '.env',
  'dist', 'build', '.next', '.nuxt', '.output',
  'coverage', '.nyc_output', '.pytest_cache',
  '.idea', '.vscode', '.vs',
  'target', 'bin', 'obj', '.gradle',
  'bower_components', 'vendor',
  '.turbo', '.cache', 'tmp', 'temp',
])

const FILE_EXTENSION_MAP = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.py': 'python', '.go': 'go', '.java': 'java',
}

const INTENT_PATTERNS = {
  auth:     { keywords: ['auth', 'login', 'password', 'credential', 'token', 'jwt', 'session', 'oauth'], patterns: [/auth|login|password|credential|token|jwt|session|oauth/i], filePatterns: ['auth', 'login', 'session', 'credential', 'oauth'] },
  user:     { keywords: ['user', 'profile', 'account', 'register', 'signup'], patterns: [/user|profile|account|register|signup/i], filePatterns: ['user', 'account', 'profile', 'member'] },
  api:      { keywords: ['api', 'endpoint', 'route', 'controller', 'handler'], patterns: [/api|endpoint|route|controller|handler/i], filePatterns: ['api', 'route', 'controller', 'handler', 'endpoint'] },
  database: { keywords: ['database', 'db', 'sql', 'mongo', 'redis', 'model', 'schema', 'table'], patterns: [/database|db|sql|mongo|redis|model|schema|table/i], filePatterns: ['db', 'database', 'model', 'schema', 'repository'] },
  config:   { keywords: ['config', 'setting', 'option', 'env'], patterns: [/config|setting|option|env/i], filePatterns: ['config', 'setting', 'env', 'option'] },
  utils:    { keywords: ['util', 'helper', 'tool', 'function', 'lib', 'common'], patterns: [/util|helper|tool|function|lib|common/i], filePatterns: ['util', 'helper', 'tool', 'lib', 'common'] },
  ui:       { keywords: ['component', 'view', 'page', 'screen', 'widget', 'button'], patterns: [/component|view|page|screen|widget|button/i], filePatterns: ['component', 'view', 'page', 'screen', 'widget', 'ui'] },
  test:     { keywords: ['test', 'spec', 'mock', 'vitest', 'jest'], patterns: [/test|spec|mock|vitest|jest/i], filePatterns: ['test', 'spec', 'mock'] },
  error:    { keywords: ['error', 'exception', 'handle', 'catch'], patterns: [/error|exception|handle|catch/i], filePatterns: ['error', 'exception', 'handler'] },
  security: { keywords: ['security', 'encrypt', 'decrypt', 'hash', 'salt'], patterns: [/security|encrypt|decrypt|hash|salt/i], filePatterns: ['security', 'crypto', 'encrypt'] },
}

module.exports = { DEFAULT_EXTENSIONS, BINARY_EXTENSIONS, EXCLUDE_DIRS, FILE_EXTENSION_MAP, INTENT_PATTERNS }
