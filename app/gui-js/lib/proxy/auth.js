const crypto = require('crypto')

// FIX-02：本地代理鉴权 + 来源校验
// 威胁模型：本机任意进程（含被投毒的其他软件）与 DNS rebinding 下的浏览器页面
// 都能访问 127.0.0.1 上的端口。loopback 绑定不构成鉴权。

const TOKEN_HEADER = 'x-contextgate-token'
const HEALTH_PATH = '/health'
const MIN_TOKEN_LENGTH = 16

// 回环主机名白名单（Host 头校验，DNS rebinding 的服务端缓解手段）
const LOOPBACK_HOSTNAMES = new Set([
  '127.0.0.1', 'localhost', '::1', '[::1]',
  '0000:0000:0000:0000:0000:0000:0000:0001',
])

// 允许的 Origin：本应用自身的 file:// 页面，以及回环 http 源。
// 任意真实站点（http/https）都被拒绝——API 客户端不会发送 Origin 头。
const ALLOWED_ORIGIN_SCHEMES = new Set(['file:', 'app:'])

function generateLocalToken() {
  return crypto.randomBytes(24).toString('base64url')
}

function ensureLocalToken(configManager) {
  let token = configManager.get('proxy.local_token')
  if (typeof token !== 'string' || token.trim().length < MIN_TOKEN_LENGTH) {
    token = generateLocalToken()
    configManager.set('proxy.local_token', token)
    configManager.save()
  }
  return token.trim()
}

function regenerateLocalToken(configManager) {
  const token = generateLocalToken()
  configManager.set('proxy.local_token', token)
  configManager.save()
  return token
}

// 从 Host 头取出主机名（去掉端口，保留 IPv6 方括号，统一小写）
function parseHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return null
  let host = hostHeader.trim().toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end === -1) return null
    return host.slice(0, end + 1)
  }
  const colon = host.lastIndexOf(':')
  if (colon !== -1) host = host.slice(0, colon)
  return host || null
}

function isLoopbackHostname(hostname) {
  if (!hostname) return false
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string') return false
  const value = origin.trim().toLowerCase()
  if (value === '' || value === 'null') return true
  try {
    const url = new URL(value)
    if (ALLOWED_ORIGIN_SCHEMES.has(url.protocol)) return true
    if ((url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url.hostname)) return true
    return false
  } catch { return false }
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function extractToken(req) {
  const headerToken = req.headers?.[TOKEN_HEADER]
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim()
  const auth = req.headers?.authorization
  if (typeof auth === 'string' && auth.trim()) return auth.replace(/^Bearer\s+/i, '').trim()
  return ''
}

function openaiError(message, code, type = 'invalid_request_error') {
  return { error: { message, type, code, param: null } }
}

function createLocalAuth(configManager, options = {}) {
  const expectedToken = options.token || ensureLocalToken(configManager)

  function authEnabled() {
    const cfg = configManager.get('proxy.auth.enabled')
    return cfg === undefined ? true : cfg !== false
  }

  function hostCheckEnabled() {
    const cfg = configManager.get('proxy.auth.host_check')
    return cfg === undefined ? true : cfg !== false
  }

  function allowedHostnames() {
    const extra = configManager.get('proxy.auth.allowed_hosts')
    const set = new Set(LOOPBACK_HOSTNAMES)
    if (Array.isArray(extra)) for (const h of extra) if (typeof h === 'string') set.add(h.trim().toLowerCase())
    return set
  }

  const middleware = function localAuth(req, res, next) {
    if (!authEnabled()) return next()

    // 1) Host 头白名单：阻断 DNS rebinding（Jackson et al., CCS'07 的缓解手段）
    if (hostCheckEnabled()) {
      const hostname = parseHostHeader(req.headers.host)
      if (!hostname || !allowedHostnames().has(hostname)) {
        return res.status(403).json(openaiError(
          `Invalid Host header: ${req.headers.host || '(missing)'}. Only loopback hosts are accepted.`,
          'invalid_host',
        ))
      }
    }

    // 2) 拒绝浏览器跨站发起：PNA 说明明确指出 CORS 防不住，请求本身就是攻击
    const origin = req.headers.origin
    if (origin !== undefined && !isAllowedOrigin(origin)) {
      return res.status(403).json(openaiError(
        `Cross-site requests are not allowed (Origin: ${origin}).`,
        'invalid_origin',
      ))
    }

    // 3) /health 豁免令牌，便于探活
    if (req.path === HEALTH_PATH) return next()

    const presented = extractToken(req)
    if (!presented || !timingSafeEqualStr(presented, expectedToken)) {
      return res.status(401).json(openaiError(
        'Missing or invalid local token. Send it as "Authorization: Bearer <proxy.local_token>" or "X-ContextGate-Token: <proxy.local_token>".',
        'invalid_api_key',
      ))
    }
    return next()
  }

  middleware.token = expectedToken
  return middleware
}

module.exports = {
  TOKEN_HEADER,
  LOOPBACK_HOSTNAMES,
  ensureLocalToken,
  regenerateLocalToken,
  generateLocalToken,
  createLocalAuth,
  parseHostHeader,
  isLoopbackHostname,
  isAllowedOrigin,
  timingSafeEqualStr,
  extractToken,
}
