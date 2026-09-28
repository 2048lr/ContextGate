const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createSecretStore, maskKey } = require('../lib/core/secret-store')

// ---------------------------------------------------------------------------
// FIX-13「密钥与 IPC 安全」验收（P1-6）
//   - safeStorage 可用时密钥加密落盘，secrets.json 里不出现明文
//   - 解密失败不抛异常：getKey() -> '' 但 hasKey() 仍为 true（UI 才能提示「需重新填写」）
//   - 无 safeStorage 且 allowPlaintextFallback: false 时拒绝写入，且不产生明文文件
//   - migrateFromConfig 把 config 里的明文 Key 搬进密钥库并清空原字段
//   - 写入原子化：不留 .tmp 残留
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-secrets-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// 假 safeStorage：isEncryptionAvailable() 恒为 true，密文形如 Buffer('enc:<明文>')。
// 更重要的是它**不是真加密**——把明文裸放在里面，才能让「文件里不得出现明文」的断言真正有区分度。
function makeFakeSafeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
    ...overrides,
  }
}

function readSecretsFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

const KEY = 'sk-1234567890abcdef'

describe('FIX-13 secret-store 加密后端', () => {
  it('setKey/getKey 往返，并暴露 backend 信息', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const store = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() })

    assert.equal(store.isEncryptionAvailable(), true)
    assert.equal(store.backendName(), 'safeStorage')
    assert.equal(store.getKey('openai'), '', '不存在的 Key 返回空串')
    assert.equal(store.hasKey('openai'), false)

    assert.equal(store.setKey('openai', KEY), true)
    assert.equal(store.getKey('openai'), KEY)
    assert.equal(store.hasKey('openai'), true)
  })

  it('listProviders/deleteKey 行为正确', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const store = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() })

    store.setKey('openai', KEY)
    store.setKey('anthropic', 'sk-ant-0000111122223333')
    assert.deepEqual(store.listProviders(), ['anthropic', 'openai'])

    assert.equal(store.deleteKey('openai'), true)
    assert.equal(store.deleteKey('openai'), false, '重复删除返回 false')
    assert.equal(store.hasKey('openai'), false)
    assert.deepEqual(store.listProviders(), ['anthropic'])

    // 删除后重新读文件（模拟重启）不应残留
    const reopened = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() })
    assert.deepEqual(reopened.listProviders(), ['anthropic'])
    assert.equal(reopened.getKey('anthropic'), 'sk-ant-0000111122223333')
  })

  it('secrets.json 中不出现明文 Key', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const store = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() })
    store.setKey('openai', KEY)

    const raw = fs.readFileSync(filePath, 'utf8')
    assert.ok(!raw.includes(KEY), '文件中不得出现明文 Key')
    assert.ok(!raw.includes('api_key'), '文件中不得出现 api_key 字段名')
    assert.equal(readSecretsFile(filePath).backend, 'safeStorage')
    assert.equal(readSecretsFile(filePath).insecure, undefined, '加密后端不应带 INSECURE 标记')
    assert.equal(fs.existsSync(filePath + '.tmp'), false)
  })

  it('decryptString 抛错时 getKey 返回空串、hasKey 仍为 true、不抛异常', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const warnings = []
    const logger = { warn: (m) => warnings.push(m), info: () => {}, error: () => {}, debug: () => {} }

    const writer = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage(), logger })
    writer.setKey('openai', KEY)

    // 模拟换机器 / DPAPI 失效：密文还在，但本机解不开
    const broken = createSecretStore({
      filePath,
      logger,
      safeStorage: makeFakeSafeStorage({
        decryptString: () => { throw new Error('DPAPI unavailable') },
      }),
    })

    assert.doesNotThrow(() => broken.getKey('openai'))
    assert.equal(broken.getKey('openai'), '')
    // 契约：条目存在但解不开 —— hasKey 仍为 true，UI 才能提示「需重新填写」而不是「未配置」
    assert.equal(broken.hasKey('openai'), true)
    assert.equal(broken.listProviders().includes('openai'), true)
    assert.ok(warnings.some((m) => m.includes('解密失败')), '应记录 warning')
  })

  it('export() 只含 providerId 与 hasKey，绝不含明文', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const store = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() })
    store.setKey('openai', KEY)

    const view = store.export()
    assert.deepEqual(view.providers, [{ providerId: 'openai', hasKey: true }])
    assert.equal(view.backend, 'safeStorage')
    assert.ok(!JSON.stringify(view).includes(KEY))
  })
})

describe('FIX-13 secret-store 明文回退与边界', () => {
  it('无 safeStorage 时回退 plaintext，文件带显式 INSECURE 标记且可读回', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const store = createSecretStore({ filePath })

    assert.equal(store.isEncryptionAvailable(), false)
    assert.equal(store.backendName(), 'plaintext')
    assert.equal(store.setKey('openai', KEY), true)
    assert.equal(store.getKey('openai'), KEY)

    const payload = readSecretsFile(filePath)
    assert.equal(payload.backend, 'plaintext')
    assert.equal(payload.insecure, true, '明文库必须有显式 INSECURE 标记')
    // 明文后端下 entries 存的是 base64 的 utf8 明文（可被解码出来，但标记已明示不安全）
    assert.equal(Buffer.from(payload.entries.openai, 'base64').toString('utf8'), KEY)
  })

  it('无 safeStorage 且 allowPlaintextFallback:false 时 setKey 返回 false 且不创建文件', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const store = createSecretStore({ filePath, allowPlaintextFallback: false })

    assert.equal(store.setKey('openai', KEY), false)
    assert.equal(store.hasKey('openai'), false)
    assert.equal(store.getKey('openai'), '')
    assert.deepEqual(store.listProviders(), [])
    assert.equal(fs.existsSync(filePath), false, '不得落盘明文密钥')
    assert.equal(store.backendName(), 'plaintext')
    assert.equal(store.export().providers.length, 0)
  })

  it('加密后端下拒绝被明文降级覆盖（避免把密文库写成假密文）', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() }).setKey('openai', KEY)

    // 同一份文件用「没有 safeStorage」的环境再打开：此时不允许写入，否则明文加进密文库会写坏数据
    const degraded = createSecretStore({ filePath })
    assert.equal(degraded.setKey('anthropic', 'sk-ant-aaaaaaaaaaaa'), false)
    assert.equal(degraded.hasKey('anthropic'), false)
    assert.deepEqual(degraded.listProviders(), ['openai'])
    const reopened = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() })
    assert.equal(reopened.getKey('openai'), KEY, '原有密文必须保持可读')
  })

  it('已有明文库遇到可用 safeStorage 时自动重新加密，且重新编码后仍可读回', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    // 先在纯 node 环境（CLI）写入明文库
    const plaintextStore = createSecretStore({ filePath })
    plaintextStore.setKey('openai', KEY)
    assert.equal(readSecretsFile(filePath).backend, 'plaintext')

    // 之后在 Electron 环境打开同一份文件：应升级后端并重新加密，而不是留下「backend 说加密、数据是明文」的错配
    const upgraded = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() })
    assert.equal(upgraded.getKey('openai'), KEY)
    const payload = readSecretsFile(filePath)
    assert.equal(payload.backend, 'safeStorage')
    assert.equal(payload.insecure, undefined)
    assert.equal(Buffer.from(payload.entries.openai, 'base64').toString('utf8'), 'enc:' + KEY)
    // 重新打开仍可读回（防「文件已标 safeStorage 但 entries 还是明文 base64」的回归）
    const reopened = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() })
    assert.equal(reopened.getKey('openai'), KEY)
  })

  it('原子写入：写完后目录内没有 .tmp 残留', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const store = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage() })
    store.setKey('openai', KEY)
    store.setKey('anthropic', 'sk-ant-0000111122223333')
    store.deleteKey('anthropic')

    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
    assert.deepEqual(fs.readdirSync(dir), ['secrets.json'])
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, 'utf8')), '落盘内容必须是完整 JSON')
  })

  it('密钥库文件损坏时不抛异常，按空库处理', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    fs.writeFileSync(filePath, '{ this is not json', 'utf8')

    const store = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage(), logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } })
    assert.doesNotThrow(() => store.getKey('openai'))
    assert.deepEqual(store.listProviders(), [])
    assert.equal(store.setKey('openai', KEY), true, '损坏后仍可重新写入')
  })

  it('maskKey 边界：示例格式、短串全星号、空串为空', () => {
    // 'sk-1234567890abcdef' 共 19 个字符：保留前 4 / 后 4，中间 11 个星号（长度 - 8）。
    // 任务描述里的示例写了 12 个星号，与其自身给出的「长度 - 8」公式不一致，这里以公式为准。
    assert.equal(maskKey('sk-1234567890abcdef'), 'sk-1***********cdef')
    assert.equal(maskKey(KEY), 'sk-1***********cdef')
    assert.equal(maskKey(''), '')
    assert.equal(maskKey(null), '')
    assert.equal(maskKey(undefined), '')
    assert.equal(maskKey('abc'), '***')
    assert.equal(maskKey('12345678901'), '*'.repeat(11))
    assert.equal(maskKey('123456789012'), '1234****9012')
    // maskKey 不应泄漏原值
    assert.ok(!maskKey(KEY).includes('567890abcdef'.slice(0, 8)))
    // 与 store 上的同名方法一致
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-secrets-'))
    try {
      const store = createSecretStore({ filePath: path.join(dir, 'secrets.json') })
      assert.equal(store.maskKey(KEY), 'sk-1***********cdef')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('FIX-13 migrateFromConfig', () => {
  function makeFakeConfigManager(providers) {
    return {
      config: { providers, workspace: 'C:/ws' },
      saved: 0,
      getProviders() { return this.config.providers },
      save() { this.saved++; return true },
    }
  }

  it('明文 api_key 迁入密钥库，config 中清空并标记 api_key_ref', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const configManager = makeFakeConfigManager({
      openai: { base_url: 'https://api.openai.com/v1', api_key: 'sk-openai-aaaaaaaaaaaa' },
      anthropic: { base_url: 'https://api.anthropic.com', api_key: 'sk-ant-bbbbbbbbbbbb' },
      local: { base_url: 'http://127.0.0.1:11434/v1', api_key: '' },
    })
    const store = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage(), configManager })

    const result = store.migrateFromConfig()
    assert.deepEqual(result.migrated.sort(), ['anthropic', 'openai'])
    assert.equal(result.backend, 'safeStorage')

    // 密钥已可从 secret store 取到
    assert.equal(store.getKey('openai'), 'sk-openai-aaaaaaaaaaaa')
    assert.equal(store.getKey('anthropic'), 'sk-ant-bbbbbbbbbbbb')
    // config 里的明文字段被清空并标记
    const providers = configManager.config.providers
    assert.equal(providers.openai.api_key, '')
    assert.equal(providers.openai.api_key_ref, 'secret')
    assert.equal(providers.anthropic.api_key, '')
    assert.equal(providers.anthropic.api_key_ref, 'secret')
    // 无 Key 的 provider 不该被改动
    assert.equal(providers.local.api_key_ref, undefined)
    assert.equal(providers.local.api_key, '')
    // 其余配置未被破坏
    assert.equal(providers.openai.base_url, 'https://api.openai.com/v1')
    assert.equal(configManager.config.workspace, 'C:/ws')
    assert.equal(configManager.saved, 1, '迁移后应调用一次 configManager.save()')

    // 落盘的 secrets.json 同样不含明文
    const raw = fs.readFileSync(filePath, 'utf8')
    assert.ok(!raw.includes('sk-openai-aaaaaaaaaaaa'))
    assert.ok(!raw.includes('sk-ant-bbbbbbbbbbbb'))
  })

  it('重复迁移是幂等的，且没有可迁移项时不调用 save()', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const configManager = makeFakeConfigManager({
      openai: { api_key: 'sk-openai-aaaaaaaaaaaa' },
    })
    const store = createSecretStore({ filePath, safeStorage: makeFakeSafeStorage(), configManager })

    assert.deepEqual(store.migrateFromConfig().migrated, ['openai'])
    assert.equal(configManager.saved, 1)
    // 第二次：api_key 已是空串，没有可迁移项
    assert.deepEqual(store.migrateFromConfig().migrated, [])
    assert.equal(configManager.saved, 1, '无可迁移项时不应再写配置')
    assert.equal(store.getKey('openai'), 'sk-openai-aaaaaaaaaaaa')
  })

  it('写入失败时保留 config 中的明文 Key（不能既丢明文又没密文）', (t) => {
    const dir = makeTmpDir(t)
    const filePath = path.join(dir, 'secrets.json')
    const configManager = makeFakeConfigManager({
      openai: { api_key: 'sk-openai-aaaaaaaaaaaa' },
    })
    const store = createSecretStore({ filePath, configManager, allowPlaintextFallback: false })

    const result = store.migrateFromConfig()
    assert.deepEqual(result.migrated, [])
    assert.equal(configManager.config.providers.openai.api_key, 'sk-openai-aaaaaaaaaaaa')
    assert.equal(configManager.saved, 0)
  })
})
