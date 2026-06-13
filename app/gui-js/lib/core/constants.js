const { version: VERSION } = require('../../package.json')

const DEFAULT_PROXY_HOST = '127.0.0.1'
const DEFAULT_PROXY_PORT = 12306

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

module.exports = { VERSION, DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT, DEFAULT_EXTENSIONS, BINARY_EXTENSIONS, EXCLUDE_DIRS }
