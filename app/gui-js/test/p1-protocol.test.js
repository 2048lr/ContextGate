const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  matchProtocolPath, allowedV1Paths, isRawBodyPath, isRawBodyRequest, isJsonContentType,
  providerHintForPath, buildUpstreamAuthHeaders, upstreamPathFor, isStreamingRequest,
  normalizeGeminiBaseUrl,
} = require('../lib/proxy/protocol')
const { ProviderRegistry, BUILTIN_PROVIDERS } = require('../lib/proxy/provider-registry')

// ---------------------------------------------------------------------------
// FIX-11 验收：协议兼容扩展
//   原实现只有 8 条 OpenAI 路径，缺 /v1/messages（Claude Code）、/v1/responses（Codex CLI）、
//   /v1/files、/v1/batches；multipart 会被 express.json 吞掉；Google 的 base_url 缺 /openai 段。
// ---------------------------------------------------------------------------

describe('FIX-11 路径注册表', () => {
  it('覆盖 OpenAI / Anthropic 原生 / Responses / 文件 / 批处理', () => {
    const cases = [
      ['/v1/chat/completions', 'chat_completions'],
      ['/v1/completions', 'completions'],
      ['/v1/embeddings', 'embeddings'],
      ['/v1/moderations', 'moderations'],
      ['/v1/models', 'models'],
      ['/v1/responses', 'responses'],
      ['/v1/responses/resp_123', 'responses_item'],
      ['/v1/messages', 'anthropic_messages'],
      ['/v1/messages/count_tokens', 'anthropic_count_tokens'],
      ['/v1/messages/batches', 'anthropic_message_batches'],
      ['/v1/files', 'files'],
      ['/v1/files/file-abc', 'file'],
      ['/v1/files/file-abc/content', 'file_content'],
      ['/v1/batches', 'batches'],
      ['/v1/batches/batch-1/cancel', 'batch'],
      ['/v1/audio/transcriptions', 'audio_speech_or_raw'],
      ['/v1/audio/speech', 'audio_speech'],
      ['/v1/images/generations', 'images_generations'],
    ]
    for (const [path, expectedId] of cases) {
      const route = matchProtocolPath(path)
      assert.ok(route, `未匹配: ${path}`)
      if (expectedId !== 'audio_speech_or_raw') assert.equal(route.id, expectedId, path)
    }
  })

  it('尾部斜杠与查询串不影响匹配', () => {
    assert.equal(matchProtocolPath('/v1/chat/completions/').id, 'chat_completions')
    assert.equal(matchProtocolPath('/v1/chat/completions?x=1').id, 'chat_completions')
  })

  it('未知路径返回 null（由路由层返回 403 path_not_allowed）', () => {
    assert.equal(matchProtocolPath('/v1/unknown'), null)
    assert.equal(matchProtocolPath('/v2/chat/completions'), null)
    assert.equal(matchProtocolPath('/admin'), null)
  })

  it('能力标记：流式 / 可缓存 / 二进制响应 / 原始 body', () => {
    assert.equal(matchProtocolPath('/v1/chat/completions').streamable, true)
    assert.equal(matchProtocolPath('/v1/chat/completions').cacheable, true)
    assert.equal(matchProtocolPath('/v1/responses').streamable, true)
    assert.equal(matchProtocolPath('/v1/messages').streamable, true)
    assert.equal(matchProtocolPath('/v1/audio/speech').binaryResponse, true)
    assert.equal(matchProtocolPath('/v1/files/file-1/content').binaryResponse, true)
    assert.equal(matchProtocolPath('/v1/files').bodyMode, 'raw')
    assert.equal(matchProtocolPath('/v1/audio/transcriptions').bodyMode, 'raw')
  })

  it('allowedV1Paths 至少包含新增的四类端点', () => {
    const paths = allowedV1Paths()
    for (const p of ['/v1/responses', '/v1/messages', '/v1/files', '/v1/batches']) {
      assert.ok(paths.includes(p), p)
    }
  })
})

describe('FIX-11 请求体模式', () => {
  const mk = (method, path, contentType) => ({ method, path, headers: contentType ? { 'content-type': contentType } : {} })

  it('multipart 一律按原始字节透传', () => {
    assert.equal(isRawBodyRequest(mk('POST', '/v1/audio/transcriptions', 'multipart/form-data; boundary=x')), true)
    assert.equal(isRawBodyRequest(mk('POST', '/v1/files', 'multipart/form-data; boundary=x')), true)
  })

  it('JSON 请求走 express.json', () => {
    assert.equal(isRawBodyRequest(mk('POST', '/v1/chat/completions', 'application/json')), false)
    assert.equal(isRawBodyRequest(mk('POST', '/v1/responses', 'application/json; charset=utf-8')), false)
    assert.equal(isRawBodyRequest(mk('POST', '/v1/messages', 'application/json')), false)
  })

  it('非 JSON 的二进制 body 也按原始字节透传', () => {
    assert.equal(isRawBodyRequest(mk('POST', '/v1/audio/speech', 'application/octet-stream')), true)
  })

  it('已知的原始 body 路径即使没有 Content-Type 也按原始处理', () => {
    assert.equal(isRawBodyRequest(mk('POST', '/v1/images/edits')), true)
    assert.equal(isRawBodyPath('/v1/files'), true)
    assert.equal(isRawBodyPath('/v1/chat/completions'), false)
  })

  it('GET/DELETE 不做 body 解析', () => {
    assert.equal(isRawBodyRequest(mk('GET', '/v1/models', 'multipart/form-data; boundary=x')), false)
    assert.equal(isRawBodyRequest(mk('DELETE', '/v1/files/x', 'application/octet-stream')), false)
  })

  it('isJsonContentType 识别 +json', () => {
    assert.equal(isJsonContentType('application/json'), true)
    assert.equal(isJsonContentType('application/vnd.api+json'), true)
    assert.equal(isJsonContentType('text/plain'), false)
  })
})

describe('FIX-11 provider 提示与鉴权头', () => {
  const cfgWith = names => ({ getProvider: name => (names.includes(name) ? { api_key: 'x' } : null) })

  it('/v1/messages 在配置了 anthropic 时提示 anthropic', () => {
    assert.equal(providerHintForPath('/v1/messages', cfgWith(['anthropic'])), 'anthropic')
  })

  it('没配置 anthropic 时不强行提示（回落到默认 provider）', () => {
    assert.equal(providerHintForPath('/v1/messages', cfgWith(['openai'])), null)
  })

  it('/v1/chat/completions 没有提示', () => {
    assert.equal(providerHintForPath('/v1/chat/completions', cfgWith(['openai'])), null)
  })

  it('OpenAI 形态用 Bearer', () => {
    const h = buildUpstreamAuthHeaders({ format: 'openai' }, 'sk-1', {})
    assert.equal(h.Authorization, 'Bearer sk-1')
    assert.equal(h['x-api-key'], undefined)
  })

  it('Anthropic 原生路径同时给出 x-api-key 与 Bearer，并带上 anthropic-version', () => {
    const h = buildUpstreamAuthHeaders({ format: 'openai' }, 'sk-ant', {}, { routeId: 'anthropic_messages' })
    assert.equal(h['x-api-key'], 'sk-ant')
    assert.equal(h.Authorization, 'Bearer sk-ant')
    assert.equal(h['anthropic-version'], '2023-06-01')
  })

  it('客户端自带的 anthropic-version / anthropic-beta 会被保留', () => {
    const h = buildUpstreamAuthHeaders({ format: 'anthropic' }, 'sk-ant', { 'anthropic-version': '2024-01-01', 'anthropic-beta': 'x-beta' })
    assert.equal(h['anthropic-version'], '2024-01-01')
    assert.equal(h['anthropic-beta'], 'x-beta')
  })

  it('Gemini 形态用 x-goog-api-key', () => {
    const h = buildUpstreamAuthHeaders({ format: 'gemini' }, 'AIza-x', {})
    assert.equal(h['x-goog-api-key'], 'AIza-x')
    assert.equal(h.Authorization, 'Bearer AIza-x')
  })

  it('没有 Key 时不产生任何鉴权头', () => {
    assert.deepEqual(buildUpstreamAuthHeaders({ format: 'openai' }, '', {}), {})
  })
})

describe('FIX-11 路径映射与 Google 修正', () => {
  it('去掉 /v1 前缀后拼到 provider base_url', () => {
    assert.equal(upstreamPathFor('/v1/chat/completions'), 'chat/completions')
    assert.equal(upstreamPathFor('/v1/messages'), 'messages')
    assert.equal(upstreamPathFor('/v1/responses'), 'responses')
    assert.equal(upstreamPathFor('/v1/files/file-1/content'), 'files/file-1/content')
  })

  it('Google base_url 补齐 /openai 兼容段', () => {
    assert.equal(
      normalizeGeminiBaseUrl('https://generativelanguage.googleapis.com/v1beta'),
      'https://generativelanguage.googleapis.com/v1beta/openai',
    )
    assert.equal(
      normalizeGeminiBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'),
      'https://generativelanguage.googleapis.com/v1beta/openai',
    )
  })

  it('其它域名不会被改写', () => {
    assert.equal(normalizeGeminiBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
  })

  it('内置 Google provider 现在指向 OpenAI 兼容段，但 format 标记保持 gemini', () => {
    assert.match(BUILTIN_PROVIDERS.google.base_url, /\/v1beta\/openai$/)
    assert.equal(BUILTIN_PROVIDERS.google.format, 'gemini')
    const reg = new ProviderRegistry()
    const p = reg.resolveProvider('google', {})
    assert.equal(p.format, 'gemini')
    assert.match(p.base_url, /\/openai$/)
  })

  it('用户自填的 Google base_url 也会被补齐', () => {
    const reg = new ProviderRegistry()
    const p = reg.resolveProvider('google', { base_url: 'https://generativelanguage.googleapis.com/v1beta' })
    assert.match(p.base_url, /\/v1beta\/openai$/)
  })
})

describe('FIX-11 流式判定', () => {
  const chat = matchProtocolPath('/v1/chat/completions')
  const countTokens = matchProtocolPath('/v1/messages/count_tokens')
  it('stream:true 的 chat/messages/responses 走流式', () => {
    assert.equal(isStreamingRequest(chat, { stream: true }, 'application/json'), true)
    assert.equal(isStreamingRequest(matchProtocolPath('/v1/messages'), { stream: true }, 'application/json'), true)
    assert.equal(isStreamingRequest(matchProtocolPath('/v1/responses'), { stream: true }, 'application/json'), true)
  })
  it('stream 缺失或 false 时不走流式', () => {
    assert.equal(isStreamingRequest(chat, {}, 'application/json'), false)
    assert.equal(isStreamingRequest(chat, { stream: false }, 'application/json'), false)
  })
  it('不可流式的端点即使写了 stream 也不走流式', () => {
    assert.equal(isStreamingRequest(countTokens, { stream: true }, 'application/json'), false)
    assert.equal(isStreamingRequest(matchProtocolPath('/v1/embeddings'), { stream: true }, 'application/json'), false)
  })
})
