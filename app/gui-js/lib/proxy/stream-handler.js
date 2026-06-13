function parseSSEChunks(rawChunks) {
  const events = []
  let buffer = ''
  for (const chunk of rawChunks) buffer += chunk.toString()
  const lines = buffer.split('\n')
  let current = { event: '', data: '', id: '', retry: '' }

  for (const line of lines) {
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
    output += `data: ${evt.data}\n\n`
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
