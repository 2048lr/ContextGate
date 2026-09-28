const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const yaml = require('js-yaml')

const { createSecretStore, absorbConfigSecrets } = require('../lib/core/secret-store')
const { ConfigManager } = require('../lib/core/config-manager')
const { ProxyServer } = require('../lib/proxy/proxy-server')
const { EventBus } = require('../lib/core/event-bus')

// ---------------------------------------------------------------------------
// FIX-13 接线验收（文档第 8 章）：
//   配置文件中不出现明文 Key，但代理仍然能拿到密钥去调用上游。
//   这里用「假 safeStorage + 真 ConfigManager + 真 ProxyServer」跑完整链路，
//   不需要 Electron 运行时。
// ---------------------------------------------------------------------------

const PLAINTEXT = 'sk-live-super-secret-key-0123456789'

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: s => Buffer.from('enc::' + s, 'utf8'),
    decryptString: b => b.toString('utf8').replace(/^enc::/, ''),
  }
}

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p1-secrets-')) })
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ } })

function writeConfigYaml(dataDir, config) {
  const cfgPath = path.join(dataDir, 'config.yaml')
  fs.writeFileSync(cfgPath, yaml.dump(config), 'utf8')
  return cfgPath
}

describe('FIX-13 配置文件里不出现明文 Key', () => {
  it('migrateFromConfig 把明文搬进加密库，配置文件里再也搜不到', () => {
    const cfgPath = writeConfigYaml(dir, {
      providers: { openai: { api_key: PLAINTEXT, models: ['gpt-4o'] } },
      default_provider: 'openai',
    })
    const store = createSecretStore({ dataDir: dir, configManager: new ConfigManager(cfgPath), safeStorage: fakeSafeStorage() })
    const r = store.migrateFromConfig()
    assert.deepEqual(r.migrated, ['openai'])
    assert.equal(r.backend, 'safeStorage')

    const onDisk = fs.readFileSync(cfgPath, 'utf8')
    assert.equal(onDisk.includes(PLAINTEXT), false, '配置文件里不能出现明文 Key')
    const parsed = yaml.load(onDisk)
    assert.equal(parsed.providers.openai.api_key, '')
    assert.equal(parsed.providers.openai.api_key_ref, 'secret')

    // 密钥仍在，可解密取回
    assert.equal(store.getKey('openai'), PLAINTEXT)
    // secrets.json 本身也不含明文
    assert.equal(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes(PLAINTEXT), false)
  })

  it('ConfigManager 注入密钥解析器后，下游读到的仍是真实 Key', () => {
    const cfgPath = writeConfigYaml(dir, { providers: { openai: { api_key: '', api_key_ref: 'secret' } } })
    const mgr = new ConfigManager(cfgPath)
    const store = createSecretStore({ dataDir: dir, configManager: mgr, safeStorage: fakeSafeStorage() })
    store.setKey('openai', PLAINTEXT)
    mgr.setSecretResolver(id => store.getKey(id))
    assert.equal(mgr.getProvider('openai').api_key, PLAINTEXT)
    assert.equal(mgr.getProviders().openai.api_key, PLAINTEXT)
    // 没有解析器时保持「密钥不在配置文件里」的事实
    const raw = new ConfigManager(cfgPath)
    assert.equal(raw.getProvider('openai').api_key, '')
  })

  it('保存配置时：掩码/留空=保留、新明文=入加密库、显式删除才清空', () => {
    const cfgPath = writeConfigYaml(dir, { providers: { openai: { api_key: '', api_key_ref: 'secret' } } })
    const store = createSecretStore({ dataDir: dir, configManager: new ConfigManager(cfgPath), safeStorage: fakeSafeStorage() })
    store.setKey('openai', PLAINTEXT)

    // 1) 掩码原样回传 → 保留
    const withMask = { providers: { openai: { api_key: store.maskKey(PLAINTEXT), api_key_ref: 'secret' } } }
    let r = absorbConfigSecrets(withMask, store)
    assert.deepEqual(r.kept, ['openai'])
    assert.equal(withMask.providers.openai.api_key, '')
    assert.equal(store.getKey('openai'), PLAINTEXT)

    // 2) 新明文 → 入加密库并清空配置字段
    const withNew = { providers: { openai: { api_key: 'sk-brand-new-key-999', api_key_ref: 'secret' } } }
    r = absorbConfigSecrets(withNew, store)
    assert.deepEqual(r.stored, ['openai'])
    assert.equal(withNew.providers.openai.api_key, '')
    assert.equal(store.getKey('openai'), 'sk-brand-new-key-999')

    // 3) 留空 → 视为「未修改」，继续保留（清空语义无法与「没动过输入框」区分，
    //    因此删除密钥必须走显式的 delete-provider-key，而不是靠留空猜）
    const blank = { providers: { openai: { api_key: '' } } }
    r = absorbConfigSecrets(blank, store)
    assert.deepEqual(r.kept, ['openai'])
    assert.deepEqual(r.cleared, [])
    assert.equal(store.getKey('openai'), 'sk-brand-new-key-999')

    // 4) 显式删除后才真的没有密钥，同时去掉 api_key_ref 标记
    store.deleteKey('openai')
    const afterDelete = { providers: { openai: { api_key: '' } } }
    r = absorbConfigSecrets(afterDelete, store)
    assert.deepEqual(r.cleared, ['openai'])
    assert.equal('api_key_ref' in afterDelete.providers.openai, false)

    // 5) 无论哪种输入，落盘结果里都不会出现明文
    const persisted = yaml.dump(absorbConfigSecrets({ providers: { openai: { api_key: PLAINTEXT } } }, store).config)
    assert.equal(persisted.includes(PLAINTEXT), false)
    assert.equal(store.getKey('openai'), PLAINTEXT)
  })
})

describe('FIX-13 代理端到端（配置无明文，但仍能鉴权上游）', () => {
  it('上游收到的是加密库里解析出来的 Key', async () => {
    const seen = []
    const upstream = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        seen.push(req.headers.authorization)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      })
    })
    await new Promise(r => upstream.listen(0, '127.0.0.1', r))

    const cfgPath = writeConfigYaml(dir, {
      providers: { openai: { api_key: PLAINTEXT, base_url: 'http://127.0.0.1:' + upstream.address().port + '/v1' } },
      default_provider: 'openai',
      proxy: { host: '127.0.0.1', port: 0 },
    })
    const mgr = new ConfigManager(cfgPath)
    const store = createSecretStore({ dataDir: dir, configManager: mgr, safeStorage: fakeSafeStorage() })
    store.migrateFromConfig()
    mgr.reload()
    mgr.setSecretResolver(id => store.getKey(id))
    assert.equal(fs.readFileSync(cfgPath, 'utf8').includes(PLAINTEXT), false)

    const proxy = new ProxyServer({ configPath: cfgPath, dataDir: dir, eventBus: new EventBus(), configManager: mgr })
    const started = await proxy.start('127.0.0.1', 0)
    try {
      const body = Buffer.from(JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }))
      const res = await new Promise(resolve => {
        const req = http.request('http://127.0.0.1:' + started.port + '/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + started.token, 'Content-Type': 'application/json', 'Content-Length': body.length },
        }, r => { let out = ''; r.on('data', c => out += c); r.on('end', () => resolve({ status: r.statusCode, text: out })) })
        req.end(body)
      })
      assert.equal(res.status, 200)
      assert.equal(seen.length, 1)
      assert.equal(seen[0], 'Bearer ' + PLAINTEXT, '上游应收到加密库解析出的 Key')
      // 配置文件在整个过程中保持无明文
      assert.equal(fs.readFileSync(cfgPath, 'utf8').includes(PLAINTEXT), false)
    } finally {
      await proxy.stop()
      await new Promise(r => upstream.close(r))
    }
  })
})
