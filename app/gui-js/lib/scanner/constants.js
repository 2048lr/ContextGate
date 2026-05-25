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

const INTENT_PATTERNS = {
  auth: {
    keywords: ['auth', 'login', 'password', 'credential', 'token', 'jwt', 'session', 'oauth', '认证', '登录', '密码', '授权'],
    patterns: [/auth|login|password|credential|token|jwt|session|oauth/i, /认证|登录|密码|授权/],
    filePatterns: ['auth', 'login', 'session', 'credential', 'oauth']
  },
  user: {
    keywords: ['user', 'profile', 'account', 'register', 'signup', '用户', '账号', '注册', '个人信息'],
    patterns: [/user|profile|account|register|signup/i, /用户|账号|注册|个人信息/],
    filePatterns: ['user', 'account', 'profile', 'member']
  },
  api: {
    keywords: ['api', 'endpoint', 'route', 'controller', 'handler', 'request', '接口', '路由', '控制器'],
    patterns: [/api|endpoint|route|controller|handler|request/i, /接口|路由|控制器/],
    filePatterns: ['api', 'route', 'controller', 'handler', 'endpoint']
  },
  database: {
    keywords: ['database', 'db', 'sql', 'mongo', 'redis', 'model', 'schema', 'table', '数据库', '查询', '存储'],
    patterns: [/database|db|sql|mongo|redis|model|schema|table/i, /数据库|查询|存储/],
    filePatterns: ['db', 'database', 'model', 'schema', 'repository', 'mongo', 'redis', 'sql']
  },
  config: {
    keywords: ['config', 'setting', 'option', 'env', 'initialization', '配置', '设置', '环境变量'],
    patterns: [/config|setting|option|env|initialization/i, /配置|设置|环境变量/],
    filePatterns: ['config', 'setting', 'env', 'option']
  },
  utils: {
    keywords: ['util', 'helper', 'tool', 'function', 'lib', 'common', '工具', '辅助', '函数'],
    patterns: [/util|helper|tool|function|lib|common/i, /工具|辅助|函数/],
    filePatterns: ['util', 'helper', 'tool', 'lib', 'common']
  },
  ui: {
    keywords: ['component', 'view', 'page', 'screen', 'widget', 'button', 'input', '界面', '组件', '页面'],
    patterns: [/component|view|page|screen|widget|button|input/i, /界面|组件|页面/],
    filePatterns: ['component', 'view', 'page', 'screen', 'widget', 'ui']
  },
  test: {
    keywords: ['test', 'spec', 'mock', 'vitest', 'jest', '测试', '单元测试'],
    patterns: [/test|spec|mock|vitest|jest/i, /测试|单元测试/],
    filePatterns: ['test', 'spec', 'mock', '__test__']
  },
  error: {
    keywords: ['error', 'exception', 'handle', 'catch', '错误', '异常', '处理'],
    patterns: [/error|exception|handle|catch/i, /错误|异常|处理/],
    filePatterns: ['error', 'exception', 'handler']
  },
  security: {
    keywords: ['security', 'encrypt', 'decrypt', 'hash', 'salt', '安全', '加密', '解密'],
    patterns: [/security|encrypt|decrypt|hash|salt/i, /安全|加密|解密/],
    filePatterns: ['security', 'crypto', 'encrypt']
  }
}

const CODE_BLOCK_SIGNATURES = {
  javascript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g,
    arrowFunction: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>\s*\{/g,
    class: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g,
    method: /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g
  },
  typescript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\([^)]*\)(?:\s*:\s*[\w<>\[\]|&]+)?\s*\{/g,
    arrowFunction: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[\w<>\[\]|&]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>\s*\{/g,
    class: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+[\w<>,\s]+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    interface: /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{/g,
    type: /(?:export\s+)?type\s+(\w+)\s*=\s*\{/g
  },
  python: {
    function: /(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[\w<>\[\]|&]+)?:/g,
    class: /class\s+(\w+)(?:\([^)]*\))?:/g
  },
  go: {
    function: /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\([^)]*\)(?:\s*\([^)]*\))?\s*\{/g,
    struct: /type\s+(\w+)\s+struct\s*\{/g,
    interface: /type\s+(\w+)\s+interface\s*\{/g
  },
  java: {
    class: /(?:public|private|protected)?\s*(?:abstract|final)?\s*class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    method: /(?:public|private|protected)?\s*(?:static|final|abstract)?\s*\w+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g
  }
}

const FILE_EXTENSION_MAP = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java'
}

const KEYWORD_PATTERNS = {
  'auth': /auth|login|password|credential|token|jwt|session|oauth/i,
  'user': /user|profile|account|register|signup/i,
  'api': /api|endpoint|route|controller|handler|request/i,
  'db': /database|db|sql|mongo|redis|model|schema|table/i,
  'config': /config|setting|option|env|initialization/i,
  'utils': /util|helper|tool|function|lib|common/i,
  'ui': /component|view|page|screen|widget|button|input/i,
  'test': /test|spec|mock|spec|vitest|jest/i,
}

module.exports = {
  DEFAULT_EXTENSIONS,
  BINARY_EXTENSIONS,
  EXCLUDE_DIRS,
  INTENT_PATTERNS,
  CODE_BLOCK_SIGNATURES,
  FILE_EXTENSION_MAP,
  KEYWORD_PATTERNS
}
