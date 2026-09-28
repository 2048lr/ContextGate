// FIX-11：协议兼容扩展
//
// 原实现的路径白名单只有 8 条 OpenAI 路径：
//   - 缺 /v1/messages（Claude Code / Anthropic 原生）、/v1/responses（Codex CLI / 新 SDK）、
//     /v1/files、/v1/batches，主流客户端直接 403；
//   - provider-registry 里声明了 Google 的 format: 'gemini'，但 router 从不使用 format，
//     base_url 又停在 .../v1beta（缺 /openai 兼容段）→ Google 实际不可用；
//   - multipart / 二进制请求体（audio、files、images/edits）会被 express.json 吞掉。
//
// 本模块把这些差异集中到一处：路径 → 路由描述（是否需要原始 body、能否流式、能否缓存、
// 默认 provider 提示），以及「按 provider 形态生成上游鉴权头」和「上游路径映射」。

// 上游可能返回二进制（而非 JSON）的路径：必须按 arraybuffer 读取再原样回写
const BINARY_RESPONSE_PATHS = [
  /^\/v1\/audio\/speech$/,
  /^\/v1\/files\/[^/]+\/content$/,
]

// 需要原始 body（multipart / 二进制）的路径
const RAW_BODY_PATHS = [
  /^\/v1\/audio\/transcriptions$/,
  /^\/v1\/audio\/translations$/,
  /^\/v1\/images\/edits$/,
  /^\/v1\/images\/variations$/,
  /^\/v1\/files$/,
]

// 路由表：顺序重要，先匹配到的先赢
const ROUTE_RULES = [
  // --- Anthropic 原生（Claude Code / Anthropic SDK）---
  { id: 'anthropic_messages', re: /^\/v1\/messages$/, bodyMode: 'json', streamable: true, cacheable: true, providerHint: 'anthropic' },
  { id: 'anthropic_count_tokens', re: /^\/v1\/messages\/count_tokens$/, bodyMode: 'json', streamable: false, cacheable: false, providerHint: 'anthropic' },
  { id: 'anthropic_message_batches', re: /^\/v1\/messages\/batches(\/[^/]+)?(\/results)?$/, bodyMode: 'json', streamable: false, cacheable: false, providerHint: 'anthropic' },

  // --- OpenAI Responses API（Codex CLI / 新 SDK 默认）---
  { id: 'responses', re: /^\/v1\/responses$/, bodyMode: 'json', streamable: true, cacheable: true, providerHint: 'openai' },
  { id: 'responses_item', re: /^\/v1\/responses\/[^/]+(\/.*)?$/, bodyMode: 'json', streamable: false, cacheable: false, providerHint: 'openai' },

  // --- 经典 OpenAI 端点 ---
  { id: 'chat_completions', re: /^\/v1\/chat\/completions$/, bodyMode: 'json', streamable: true, cacheable: true },
  { id: 'completions', re: /^\/v1\/completions$/, bodyMode: 'json', streamable: true, cacheable: true },
  { id: 'embeddings', re: /^\/v1\/embeddings$/, bodyMode: 'json', streamable: false, cacheable: true },
  { id: 'models', re: /^\/v1\/models$/, bodyMode: 'json', streamable: false, cacheable: false },
  { id: 'model', re: /^\/v1\/models\/[^/]+$/, bodyMode: 'json', streamable: false, cacheable: false },
  { id: 'images_generations', re: /^\/v1\/images\/generations$/, bodyMode: 'json', streamable: false, cacheable: false },
  // multipart 上传类端点：必须整体透传原始字节，express.json 会把它们解析坏
  { id: 'images_edits', re: /^\/v1\/images\/edits$/, bodyMode: 'raw', streamable: false, cacheable: false },
  { id: 'images_variations', re: /^\/v1\/images\/variations$/, bodyMode: 'raw', streamable: false, cacheable: false },
  { id: 'audio_transcriptions', re: /^\/v1\/audio\/transcriptions$/, bodyMode: 'raw', streamable: false, cacheable: false },
  { id: 'audio_translations', re: /^\/v1\/audio\/translations$/, bodyMode: 'raw', streamable: false, cacheable: false },
  { id: 'audio_speech', re: /^\/v1\/audio\/speech$/, bodyMode: 'json', streamable: false, cacheable: false },
  { id: 'moderations', re: /^\/v1\/moderations$/, bodyMode: 'json', streamable: false, cacheable: false },

  // --- 文件与批处理 ---
  { id: 'files', re: /^\/v1\/files$/, bodyMode: 'raw', streamable: false, cacheable: false, providerHint: 'openai' },
  { id: 'file', re: /^\/v1\/files\/[^/]+$/, bodyMode: 'json', streamable: false, cacheable: false, providerHint: 'openai' },
  { id: 'file_content', re: /^\/v1\/files\/[^/]+\/content$/, bodyMode: 'json', streamable: false, cacheable: false, providerHint: 'openai' },
  { id: 'batches', re: /^\/v1\/batches$/, bodyMode: 'json', streamable: false, cacheable: false, providerHint: 'openai' },
  { id: 'batch', re: /^\/v1\/batches\/[^/]+(\/cancel)?$/, bodyMode: 'json', streamable: false, cacheable: false, providerHint: 'openai' },
]

function matchProtocolPath(pathname) {
  if (typeof pathname !== 'string' || !pathname) return null
  // 去掉查询串与尾部斜杠，保持与旧白名单一致的匹配语义
  const clean = pathname.split('?')[0]
  const normalized = clean.length > 1 ? clean.replace(/\/+$/, '') : clean
  for (const rule of ROUTE_RULES) {
    if (rule.re.test(normalized)) {
      return {
        id: rule.id,
        path: normalized,
        bodyMode: rule.bodyMode,
        streamable: rule.streamable === true,
        cacheable: rule.cacheable === true,
        providerHint: rule.providerHint || null,
        binaryResponse: BINARY_RESPONSE_PATHS.some(re => re.test(normalized)),
      }
    }
  }
  return null
}

function allowedV1Paths() {
  // 供 /v1 发现接口展示：把正则还原成人能读的样例（不追求穷举）
  return [
    '/v1/chat/completions', '/v1/completions', '/v1/embeddings',
    '/v1/models', '/v1/images/generations', '/v1/audio/transcriptions',
    '/v1/audio/translations', '/v1/audio/speech', '/v1/moderations',
    '/v1/responses', '/v1/messages', '/v1/messages/count_tokens',
    '/v1/files', '/v1/batches',
  ]
}

function isRawBodyPath(pathname) {
  const route = matchProtocolPath(pathname)
  if (route && route.bodyMode === 'raw') return true
  const clean = String(pathname || '').split('?')[0]
  return RAW_BODY_PATHS.some(re => re.test(clean))
}

/**
 * 请求体是否必须以原始字节透传（multipart / 二进制）。
 * 判断顺序：显式路径 → Content-Type。
 */
function isRawBodyRequest(req) {
  const method = String(req.method || '').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE' || method === 'OPTIONS') return false
  const contentType = String(req.headers?.['content-type'] || '').toLowerCase()
  if (contentType.startsWith('multipart/form-data')) return true
  if (contentType && !isJsonContentType(contentType)) return true
  return isRawBodyPath(req.path)
}

function isJsonContentType(contentType) {
  const ct = String(contentType || '').toLowerCase()
  return ct.includes('application/json') || ct.includes('+json') || ct.includes('text/json')
}

/**
 * 路径 → 默认 provider 提示。
 * 只有「该 provider 确实被显式配置过」时才采用提示，否则交回常规探测，
 * 避免用户只配了 OpenAI 时 /v1/messages 被塞到未配置的 Anthropic 上。
 */
function providerHintForPath(pathname, configManager) {
  const route = matchProtocolPath(pathname)
  if (!route || !route.providerHint) return null
  if (!configManager) return route.providerHint
  try {
    const configured = configManager.getProvider(route.providerHint)
    if (configured && Object.keys(configured).length > 0) return route.providerHint
  } catch { /* 配置读取失败时忽略提示 */ }
  return null
}

/**
 * 按 provider 形态生成上游鉴权头。
 * OpenAI 兼容 → Authorization: Bearer；Anthropic 原生 → x-api-key；
 * Gemini 原生 → x-goog-api-key。
 */
function buildUpstreamAuthHeaders(providerConfig, apiKey, clientHeaders = {}, options = {}) {
  const headers = {}
  if (!apiKey) return headers
  const format = String(providerConfig?.format || 'openai').toLowerCase()
  // Anthropic 原生 /v1/messages 只认 x-api-key；其 OpenAI 兼容层认 Bearer。
  // 两个都带上，让同一个 provider 配置既能接 Claude Code 也能接 OpenAI SDK。
  const nativeAnthropic = String(options.routeId || '').startsWith('anthropic_')
  if (format === 'anthropic' || nativeAnthropic) {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
    headers['anthropic-version'] = clientHeaders['anthropic-version'] || providerConfig?.anthropic_version || '2023-06-01'
    if (clientHeaders['anthropic-beta']) headers['anthropic-beta'] = clientHeaders['anthropic-beta']
  } else if (format === 'gemini') {
    // Google 的 OpenAI 兼容端点同时接受 x-goog-api-key 与 Bearer
    headers['x-goog-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

/** 客户端 → 上游路径映射：去掉 /v1 前缀后拼到 provider base_url 上 */
function upstreamPathFor(pathname) {
  const clean = String(pathname || '').split('?')[0]
  return clean.replace(/^\/v1\//, '/').replace(/^\/+/, '')
}

/** 该请求是否应按流式转发 */
function isStreamingRequest(route, body, contentType) {
  if (!route || !route.streamable) return false
  if (isJsonContentType(contentType) === false && contentType) return false
  return body && typeof body === 'object' && body.stream === true
}

/** Gemini 的 OpenAI 兼容段：base_url 若停在 /v1beta，补上 /openai */
function normalizeGeminiBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl) return baseUrl
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!/generativelanguage\.googleapis\.com/i.test(trimmed)) return trimmed
  if (/\/openai$/i.test(trimmed)) return trimmed
  if (/\/v1beta$/i.test(trimmed) || /\/v1beta\/openai$/i.test(trimmed)) return trimmed + '/openai'
  return trimmed
}

module.exports = {
  ROUTE_RULES,
  matchProtocolPath,
  allowedV1Paths,
  isRawBodyPath,
  isRawBodyRequest,
  isJsonContentType,
  providerHintForPath,
  buildUpstreamAuthHeaders,
  upstreamPathFor,
  isStreamingRequest,
  normalizeGeminiBaseUrl,
}
