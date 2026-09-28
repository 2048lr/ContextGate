const fs = require('fs')
const path = require('path')

// FIX-13「密钥与 IPC 安全」核心模块：
//   - Key 不再以明文写进 config.yaml，而是交给 Electron safeStorage（Windows 走 DPAPI）加密后落盘到独立的 secrets.json
//   - 主进程与渲染层之间只交换「掩码 + has_key」，明文只在本模块内出现
// 设计约束（为什么不这么做会被判为缺陷）：
//   1) 解密失败（换机器 / DPAPI 失效 / 用户配置被拷贝）时**绝不抛异常**，否则主进程启动即崩；
//      此时 getKey() 返回 ''，但 hasKey() 仍为 true —— 目的是让 UI 能提示「密钥已失效，需重新填写」，
//      而不是悄悄当成「没配置过」，把用户引向一个更困惑的状态。
//   2) 没有 safeStorage 的纯 Node 环境（单测 / CLI）允许降级为 plaintext，但必须在文件里留下显式
//      INSECURE 标记，让「这不是加密存储」这件事可被检测、可被诊断。
//   3) 写文件必须原子（先 .tmp 再 rename），否则掉电/崩溃会把密钥库写成半个文件，用户所有 Key 一起丢。
const FILE_VERSION = 1
const SECRET_FILE_NAME = 'secrets.json'
const PLAINTEXT_BACKEND = 'plaintext'
const SAFE_STORAGE_BACKEND = 'safeStorage'

// 只在入口处归一化一次，避免各方法里重复写防御性代码
function normalizeLogger(logger) {
  const target = logger || console
  const noop = () => {}
  return {
    debug: typeof target.debug === 'function' ? target.debug.bind(target) : noop,
    info: typeof target.info === 'function' ? target.info.bind(target) : noop,
    warn: typeof target.warn === 'function' ? target.warn.bind(target) : noop,
    error: typeof target.error === 'function' ? target.error.bind(target) : noop,
  }
}

// 用码点切分而不是 slice：Key 长度足够长时若首尾恰是代理对，slice 会切出半个字符
function maskKey(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  const chars = Array.from(value)
  // 太短的值如果保留首尾，等于把整个 Key 泄出去，所以一律全星号
  if (chars.length < 12) return '*'.repeat(chars.length)
  return chars.slice(0, 4).join('') + '*'.repeat(chars.length - 8) + chars.slice(-4).join('')
}

// 用户可能把 Key 粘贴进 providerId；含路径分隔符或 . / .. 的 id 会变成目录穿越写文件
function isValidProviderId(id) {
  if (typeof id !== 'string') return false
  const trimmed = id.trim()
  if (trimmed.length === 0 || trimmed.length > 200) return false
  if (trimmed === '.' || trimmed === '..') return false
  return !/[\u0000-\u001f]/.test(trimmed) && !trimmed.includes('/') && !trimmed.includes('\\')
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function createSecretStore({
  dataDir,
  filePath,
  configManager,
  safeStorage,
  allowPlaintextFallback = true,
  logger,
} = {}) {
  const log = normalizeLogger(logger)
  const resolvedPath = filePath || path.join(dataDir || process.cwd(), SECRET_FILE_NAME)

  // 一次调用只判断一次后端：DPAPI 可用性在同一进程内不会来回翻转，反复探测只会让分支更难读
  const encryptionAvailable = detectEncryptionAvailable(safeStorage)
  const backend = encryptionAvailable ? SAFE_STORAGE_BACKEND : PLAINTEXT_BACKEND

  // 惰性状态：构造函数不做磁盘 IO（文件可能很大，且构造发生在 app ready 之前）
  let loaded = false
  let fileBackend = backend
  const entries = new Map()

  function detectEncryptionAvailable(store) {
    if (!store || typeof store.isEncryptionAvailable !== 'function') return false
    try {
      return store.isEncryptionAvailable() === true
    } catch (e) {
      log.warn('[secrets] safeStorage.isEncryptionAvailable() 抛错，按不可用处理：' + e.message)
      return false
    }
  }

  function atomicWriteFileSync(target, text) {
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    try {
      // Windows 上 mode 基本被忽略，但在 POSIX 上能拦住同机其他用户直接读密文文件
      fs.chmodSync(tmp, 0o600)
    } catch {
      // 平台不支持 chmod（Windows）时静默忽略，不能因为权限位失败就拒绝保存密钥
    }
    fs.renameSync(tmp, target)
  }

  function cleanupTmpFiles() {
    try {
      const tmp = resolvedPath + '.tmp'
      if (fs.existsSync(tmp)) {
        fs.unlinkSync(tmp)
        log.warn('[secrets] 清理上次写入失败残留的临时文件')
      }
    } catch (e) {
      log.warn('[secrets] 清理临时文件失败：' + e.message)
    }
  }

  function load() {
    if (loaded) return
    loaded = true
    cleanupTmpFiles()
    let raw = null
    try {
      if (!fs.existsSync(resolvedPath)) return
      raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
    } catch (e) {
      // 文件损坏时保持空库而不是抛异常：宁可让用户重填，也不能让主进程起不来
      log.error('[secrets] 密钥库读取/解析失败，按空库处理：' + e.message)
      return
    }
    if (!isPlainObject(raw)) {
      log.error('[secrets] 密钥库格式异常（非对象），按空库处理')
      return
    }
    // 以文件自述的后端为准来解码：旧版本可能用 plaintext 落盘，而本次运行 safeStorage 恰好可用，
    // 若按当前后端去 decryptString 明文条目，会得到乱码甚至抛错
    if (raw.backend === PLAINTEXT_BACKEND || raw.backend === SAFE_STORAGE_BACKEND) fileBackend = raw.backend
    if (raw.insecure === true) {
      log.warn('[secrets] 当前密钥库为明文存储（INSECURE），建议在 Electron 环境中重新保存密钥')
    }
    const source = isPlainObject(raw.entries) ? raw.entries : {}
    for (const id of Object.keys(source)) {
      if (typeof source[id] === 'string') entries.set(id, source[id])
    }
    // 明文库 + 本次运行可用加密后端：立刻把存量明文重新加密，避免明文长期滞留。
    // entries 必须同时重新编码，否则文件 backend 已写成 safeStorage 而数据还是明文 base64，
    // 下次读取会走 decryptString 得到乱码。
    if (fileBackend === PLAINTEXT_BACKEND && encryptionAvailable && allowPlaintextFallback !== false && entries.size > 0) {
      fileBackend = SAFE_STORAGE_BACKEND
      for (const [id, value] of entries) entries.set(id, encodeEntry(Buffer.from(value, 'base64').toString('utf8')))
      save()
      log.info('[secrets] 已将 ' + entries.size + ' 个明文密钥重新加密为 safeStorage 存储')
    }
  }

  function save() {
    // 显式关闭明文回退且没有加密后端时，绝不落盘（否则等于把「拒绝明文」变成「偷偷明文」）
    if (backend === PLAINTEXT_BACKEND && allowPlaintextFallback === false) {
      log.warn('[secrets] 无安全存储可用且已禁用明文回退，拒绝写入密钥库文件')
      return false
    }
    const payload = {
      version: FILE_VERSION,
      backend: fileBackend,
      entries: {},
    }
    if (fileBackend === PLAINTEXT_BACKEND) payload.insecure = true
    for (const [id, value] of entries) payload.entries[id] = value
    try {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
      atomicWriteFileSync(resolvedPath, JSON.stringify(payload, null, 2))
      return true
    } catch (e) {
      log.error('[secrets] 密钥库写入失败：' + e.message)
      return false
    }
  }

  function encodeEntry(plaintext) {
    if (fileBackend === SAFE_STORAGE_BACKEND) {
      const encrypted = safeStorage.encryptString(plaintext)
      if (!Buffer.isBuffer(encrypted)) throw new Error('safeStorage.encryptString 返回值不是 Buffer')
      return encrypted.toString('base64')
    }
    // 明文后端下 entries 存的是 base64 的 utf8 明文（不是密文），配合 insecure 标记可被一眼识别
    return Buffer.from(plaintext, 'utf8').toString('base64')
  }

  function decodeEntry(stored) {
    try {
      if (fileBackend === SAFE_STORAGE_BACKEND) {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'))
      }
      return Buffer.from(stored, 'base64').toString('utf8')
    } catch (e) {
      // 换机器 / DPAPI 失效 / 密文被截断都会走到这里：记录 warning 并返回空串，绝不向上抛
      log.warn('[secrets] 密钥解密失败（可能换了机器或 DPAPI 凭据失效），需用户重新填写：' + e.message)
      return ''
    }
  }

  return {
    isEncryptionAvailable() {
      return encryptionAvailable
    },

    backendName() {
      return encryptionAvailable ? SAFE_STORAGE_BACKEND : PLAINTEXT_BACKEND
    },

    getKey(providerId) {
      if (!isValidProviderId(providerId)) return ''
      load()
      const stored = entries.get(providerId)
      if (typeof stored !== 'string') return ''
      return decodeEntry(stored)
    },

    // 解密失败时 getKey 为空但 hasKey 仍为 true：条目确实存在，只是当前环境解不开，
    // UI 据此提示「需重新填写」而不是「未配置」
    hasKey(providerId) {
      if (!isValidProviderId(providerId)) return false
      load()
      return entries.has(providerId)
    },

    setKey(providerId, plaintext) {
      if (!isValidProviderId(providerId)) {
        log.warn('[secrets] 拒绝写入：providerId 非法')
        return false
      }
      if (typeof plaintext !== 'string') {
        log.warn('[secrets] 拒绝写入：密钥必须是字符串')
        return false
      }
      if (!encryptionAvailable && allowPlaintextFallback === false) {
        log.warn('[secrets] 无安全存储可用且已禁用明文回退，拒绝保存密钥：' + providerId)
        return false
      }
      // 必须先 load：fileBackend 要由文件自述内容决定，判断顺序反了会把密文库当成明文库覆盖
      load()
      // 已有密文库不能被明文覆盖：这正是「降级写」的典型事故路径
      if (fileBackend === SAFE_STORAGE_BACKEND && !encryptionAvailable) {
        log.warn('[secrets] 现有密钥库为加密存储，当前环境无法加密，拒绝以明文覆盖：' + providerId)
        return false
      }
      if (encryptionAvailable && fileBackend !== SAFE_STORAGE_BACKEND) fileBackend = SAFE_STORAGE_BACKEND
      entries.set(providerId, encodeEntry(plaintext))
      return save()
    },

    deleteKey(providerId) {
      if (!isValidProviderId(providerId)) return false
      load()
      if (!entries.has(providerId)) return false
      entries.delete(providerId)
      save()
      return true
    },

    listProviders() {
      load()
      return Array.from(entries.keys()).sort()
    },

    maskKey,

    // 把 config.yaml 里的明文 api_key 搬进加密库，然后清空原字段并标记 api_key_ref: 'secret'，
    // 让「已经迁移过」这件事在配置里可见，也避免下游代码再去读空字段
    migrateFromConfig() {
      const migrated = []
      const providers = readProviders(configManager)
      if (!isPlainObject(providers)) return { migrated, backend }

      const changed = []
      for (const providerId of Object.keys(providers)) {
        const provider = providers[providerId]
        if (!isPlainObject(provider)) continue
        const apiKey = provider.api_key
        if (typeof apiKey !== 'string' || apiKey.length === 0) continue
        if (!this.setKey(providerId, apiKey)) {
          // 迁移失败必须保留明文原值，否则用户既丢了明文又没拿到密文
          log.error('[secrets] 迁移失败，保留配置中的明文密钥：' + providerId)
          continue
        }
        provider.api_key = ''
        provider.api_key_ref = 'secret'
        migrated.push(providerId)
        changed.push(providerId)
      }
      if (changed.length > 0 && configManager && typeof configManager.save === 'function') {
        try {
          configManager.save()
        } catch (e) {
          log.error('[secrets] 配置保存失败，明文密钥可能已清空但未落盘：' + e.message)
        }
      }
      if (migrated.length > 0) log.info('[secrets] 已迁移 ' + migrated.length + ' 个 provider 的明文密钥')
      return { migrated, backend }
    },

    // 安全视图：只暴露「谁有密钥」，结构上就没有明文可泄漏，可直接交给 IPC/诊断使用
    export() {
      load()
      const providers = Array.from(entries.keys()).sort().map((providerId) => ({
        providerId,
        hasKey: true,
      }))
      return {
        version: FILE_VERSION,
        backend,
        encryptionAvailable,
        insecure: backend === PLAINTEXT_BACKEND,
        providers,
      }
    },

    filePath: resolvedPath,
  }
}

function readProviders(configManager) {
  if (!configManager) return {}
  try {
    if (typeof configManager.getProviders === 'function') {
      const fromGetter = configManager.getProviders()
      if (isPlainObject(fromGetter)) return fromGetter
    }
  } catch {
    // 落到 config 直读作为兜底
  }
  const config = configManager.config
  if (isPlainObject(config) && isPlainObject(config.providers)) return config.providers
  return {}
}

/**
 * FIX-13：保存配置前的「吸收密钥」步骤。
 *
 * 渲染进程拿到的只有掩码，因此必须区分三种输入：
 *   - 输入框里是掩码（或为空）→ 视为「未修改」，保留加密库里已有的密钥；
 *   - 输入框里是新明文        → 写入加密库，配置里只留 api_key_ref: 'secret'；
 *   - 该 provider 本来就没有密钥且输入为空 → 清掉标记。
 * 结果：config.yaml 里永远不会出现明文 Key（除非加密后端完全不可用且被显式允许明文回退）。
 *
 * @param {object} config 待落盘的配置对象（会被就地修改）
 * @param {object} store  createSecretStore() 的返回值
 * @returns {{config:object, stored:string[], kept:string[], cleared:string[]}}
 */
function absorbConfigSecrets(config, store) {
  const result = { config, stored: [], kept: [], cleared: [] }
  if (!isPlainObject(config) || !isPlainObject(config.providers) || !store) return result
  for (const providerId of Object.keys(config.providers)) {
    const provider = config.providers[providerId]
    if (!isPlainObject(provider)) continue
    const raw = typeof provider.api_key === 'string' ? provider.api_key.trim() : ''
    delete provider.has_api_key
    let existing = ''
    try { existing = store.getKey(providerId) || '' } catch { existing = '' }
    const isMask = raw.length > 0 && existing.length > 0 && raw === store.maskKey(existing)
    if (raw.length === 0 || isMask) {
      if (existing.length > 0) {
        provider.api_key = ''
        provider.api_key_ref = 'secret'
        result.kept.push(providerId)
      } else {
        provider.api_key = ''
        delete provider.api_key_ref
        result.cleared.push(providerId)
      }
      continue
    }
    if (store.setKey(providerId, raw)) {
      provider.api_key = ''
      provider.api_key_ref = 'secret'
      result.stored.push(providerId)
    }
    // setKey 失败时保留明文原值吗？不。宁可让用户重新填写，也不能把明文写进配置文件。
    else {
      provider.api_key = ''
      delete provider.api_key_ref
      result.cleared.push(providerId)
    }
  }
  return result
}

module.exports = { createSecretStore, maskKey, absorbConfigSecrets, SECRET_FILE_NAME, FILE_VERSION }
