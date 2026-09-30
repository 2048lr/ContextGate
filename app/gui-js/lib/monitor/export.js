// FIX-17：请求日志与统计的 CSV/JSON 导出。
//
// 纯函数实现，不依赖任何外部库，便于 CLI 与 HTTP 端点共用同一套序列化逻辑。

const CSV_COLUMNS = [
  'id', 'timestamp', 'provider', 'model', 'method', 'path', 'status', 'cached',
  'responseTime', 'inputTokens', 'outputTokens', 'cost', 'error', 'messagePreview',
]

/** RFC 4180：含逗号/引号/换行的字段要用双引号包裹，内部双引号翻倍 */
function csvCell (value) {
  if (value === undefined || value === null) return ''
  const text = String(value)
  if (text.indexOf(',') === -1 && text.indexOf('"') === -1 && text.indexOf('\n') === -1 && text.indexOf('\r') === -1) return text
  return '"' + text.split('"').join('""') + '"'
}

function toCsv (rows, columns = CSV_COLUMNS) {
  const header = columns.join(',')
  const body = (Array.isArray(rows) ? rows : []).map(row => columns.map(col => csvCell(row ? row[col] : '')).join(','))
  return [header, ...body].join('\r\n') + '\r\n'
}

function toJson (rows, options = {}) {
  const payload = {
    exportedAt: options.exportedAt || new Date().toISOString(),
    count: Array.isArray(rows) ? rows.length : 0,
    entries: Array.isArray(rows) ? rows : [],
  }
  if (options.metadata && typeof options.metadata === 'object') Object.assign(payload, options.metadata)
  return JSON.stringify(payload, null, options.pretty === false ? 0 : 2)
}

function normalizeFormat (value, fallback = 'json') {
  const text = String(value || '').trim().toLowerCase()
  return text === 'csv' || text === 'json' ? text : fallback
}

/**
 * @returns {{ body: string, contentType: string, extension: string }}
 */
function serialize (rows, options = {}) {
  const format = normalizeFormat(options.format)
  if (format === 'csv') return { body: toCsv(rows, options.columns), contentType: 'text/csv; charset=utf-8', extension: 'csv' }
  return { body: toJson(rows, options), contentType: 'application/json; charset=utf-8', extension: 'json' }
}

module.exports = { CSV_COLUMNS, csvCell, toCsv, toJson, normalizeFormat, serialize }
