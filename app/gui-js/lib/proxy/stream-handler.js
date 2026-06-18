function parseSSEChunks(rawChunks) {
  const events = []
  let buffer = ''
  for (const chunk of rawChunks) buffer += chunk.toString()
  const lines = buffer.split('\n')
  let current = { event: '', data: '', id: '', retry: '' }

  for (const rawLine of lines) {
    // 兼容 CRLF 行尾：去除尾部 \r，否则空行变成 '\r' 导致事件无法分隔
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      if (current.data || current.event) events.push({ ...current })
      current = { event: '', data: '', id: '', retry: '' }
      continue
    }
    if (line.startsWith('event:')) current.event = line.substring(6).trim()
    else if (line.startsWith('data:')) {
      const val = line.substring(5).trim()
      current.data = current.data ? current.data + '\n' + val : val
    }
    else if (line.startsWith('id:')) current.id = line.substring(3).trim()
    else if (line.startsWith('retry:')) current.retry = line.substring(6).trim()
  }
  if (current.data || current.event) events.push({ ...current })
  return events
}

function serializeSSEEvents(events) {
  let output = ''
  for (const evt of events) {
    if (evt.id) output += `id: ${evt.id}\n`
    if (evt.event) output += `event: ${evt.event}\n`
    if (evt.retry) output += `retry: ${evt.retry}\n`
    // 多行 data 必须每行单独加 "data: " 前缀，否则不符合 SSE 规范
    for (const dataLine of (evt.data || '').split('\n')) {
      output += `data: ${dataLine}\n`
    }
    output += '\n'
  }
  return output
}

function extractMsgPreview(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const last = messages[messages.length - 1]
  if (!last?.content) return ''
  const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
  return text.length > 80 ? text.substring(0, 80) + '…' : text
}

module.exports = { parseSSEChunks, serializeSSEEvents, extractMsgPreview }
