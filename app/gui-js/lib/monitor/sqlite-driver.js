const fs = require('fs')
const path = require('path')

// FIX-12 数据层重做：这一层只回答两个问题 —— 用哪个 sqlite 引擎、怎么写才不丢数据。
// 主驱动 node:sqlite 直接读写磁盘库（WAL + 增量 INSERT），不再每 5 秒 export 全库；
// 回退驱动 sql.js 是纯内存库，只能整体落盘，因此额外补上「原子替换 + 写前合并 + 锁文件串行化」，
// 消除 P1-4 里「两个实例先后 close，先关闭者的数据被后关闭者的内存快照整体覆盖」的丢数据缺陷。

const NODE_SQLITE = 'node:sqlite'
const SQL_JS = 'sql.js'

// 持锁进程崩溃会留下永久残留的锁文件，超过这个时长才允许接管
const LOCK_STALE_MS = 10000
const LOCK_WAIT_MS = 3000
const RENAME_RETRY = 5
// 只清理明显是崩溃残留的临时文件，避免删掉别的实例正在写的那一个
const TEMP_FILE_TTL_MS = 60000

let availableCache = null

function tryRequire (id) {
  try { return require(id) } catch { return null }
}

/** 当前环境可用的驱动名，按优先级排列 */
function availableDrivers () {
  if (!availableCache) {
    const list = []
    // node:sqlite 是 Node 22.5+ 的内置模块；不可用时静默降级，绝不因此让代理起不来
    const nodeSqlite = tryRequire(NODE_SQLITE)
    if (nodeSqlite && typeof nodeSqlite.DatabaseSync === 'function') list.push(NODE_SQLITE)
    if (tryRequire(SQL_JS)) list.push(SQL_JS)
    availableCache = list
  }
  return availableCache.slice()
}

/**
 * 打开数据库。同步 API（run/all/get/exec），只有 sql.js 回退驱动的初始化是异步的，
 * 调用方通过 await db.ready() 等待（node:sqlite 下立即 resolve）。
 */
function openDatabase (options = {}) {
  const dbPath = options.dbPath || options.path
  if (!dbPath) throw new Error('openDatabase 需要 dbPath')
  const logger = wrapLogger(options.logger)
  const requested = options.driver || 'auto'
  const available = availableDrivers()
  if (requested !== 'auto' && requested !== NODE_SQLITE && requested !== SQL_JS) {
    logger.warn(`未知的数据库驱动 ${requested}，按自动选择处理`)
  }
  if (requested !== SQL_JS && available.includes(NODE_SQLITE)) {
    try {
      return createNodeSqliteDriver(dbPath, logger)
    } catch (e) {
      // 模块在但打不开库（老 Electron 的实验实现、权限、损坏文件）也要能降级，
      // 否则用户会直接从「统计不可用」变成「代理起不来」
      logger.warn(`node:sqlite 打开数据库失败（${e.message}），回退 sql.js`)
    }
  } else if (requested === NODE_SQLITE) {
    logger.warn('node:sqlite 不可用，回退 sql.js')
  }
  return createSqlJsDriver(dbPath, logger)
}

function wrapLogger (logger) {
  const base = logger || console
  const pick = (level) => {
    const fn = base && typeof base[level] === 'function' ? base[level] : null
    return fn ? fn.bind(base) : () => {}
  }
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') }
}

function ensureParentDir (dbPath) {
  if (dbPath === ':memory:') return
  const dir = path.dirname(dbPath)
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function statOf (p) {
  try {
    const st = fs.statSync(p)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch { return null }
}

// 同步 API 里没法 await，锁竞争时用 Atomics.wait 真正睡一会儿，而不是空转烧 CPU
function sleepSync (ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* 环境不支持 Atomics.wait 时的兜底 */ }
  }
}

// node:sqlite 的匿名参数只能按位置展开；命名参数（对象）原样透传
function positionParams (params) {
  if (params === undefined || params === null) return []
  return Array.isArray(params) ? params : [params]
}

// ---------------------------------------------------------------------------
// 驱动 A：node:sqlite（磁盘库，增量写，WAL）
// ---------------------------------------------------------------------------

function createNodeSqliteDriver (dbPath, logger) {
  const nodeSqlite = tryRequire(NODE_SQLITE)
  if (!nodeSqlite || typeof nodeSqlite.DatabaseSync !== 'function') throw new Error('node:sqlite 不可用')
  ensureParentDir(dbPath)
  const db = new nodeSqlite.DatabaseSync(dbPath)
  // WAL：读写互不阻塞，GUI 与 CLI 同时开着也不会互相卡住；
  // synchronous=NORMAL 在 WAL 下兼顾性能与断电安全（已提交事务不会丢）；
  // busy_timeout 让短时锁冲突自动等待，而不是立刻抛 SQLITE_BUSY。
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA busy_timeout=5000')
  let closed = false
  return {
    driverName: NODE_SQLITE,
    path: dbPath,
    // 磁盘库：每次 run 就已经落盘，没有内存批次需要补写
    isPersistent: true,
    async ready () {},
    run (sql, params) {
      const result = db.prepare(sql).run(...positionParams(params))
      return {
        changes: Number(result && result.changes) || 0,
        lastInsertRowid: result ? result.lastInsertRowid : undefined,
      }
    },
    all (sql, params) { return db.prepare(sql).all(...positionParams(params)) },
    get (sql, params) { return db.prepare(sql).get(...positionParams(params)) },
    exec (sql) { db.exec(sql) },
    // node:sqlite 没有待落盘的内存数据，flush 是 no-op（保留它是为了两个驱动同形）
    flush () {},
    close () {
      if (closed) return
      closed = true
      try { db.close() } catch (e) { logger.warn(`关闭数据库失败: ${e.message}`) }
    },
  }
}

// ---------------------------------------------------------------------------
// 驱动 B：sql.js（内存库 + 整体落盘，兼容老环境）
// ---------------------------------------------------------------------------

function createSqlJsDriver (dbPath, logger) {
  const lockPath = dbPath + '.lock'
  let SQL = null
  let db = null
  let ready = false
  let closed = false
  // 自上次成功落盘以来的写入：合并别人的数据时要靠它把自己的改动重放回去
  const journal = []
  // exec 只用于幂等 DDL；重新读盘合并时要先把表结构补回来
  const ddl = []
  let lastLoad = null

  const readyPromise = (async () => {
    const initSqlJs = tryRequire(SQL_JS)
    if (typeof initSqlJs !== 'function') throw new Error('sql.js 不可用')
    SQL = await initSqlJs()
    ensureParentDir(dbPath)
    removeStaleTempFiles(dbPath)
    db = loadFromDisk()
    lastLoad = statOf(dbPath)
    ready = true
    // close() 可能在初始化期间就被调用了，此时不能再留下没人管的句柄
    if (closed) { try { db.close() } catch { /* 忽略 */ } db = null; ready = false }
  })()

  function loadFromDisk () {
    let bytes = null
    try {
      if (fs.existsSync(dbPath)) bytes = fs.readFileSync(dbPath)
    } catch (e) {
      logger.warn(`读取数据库文件失败: ${e.message}`)
    }
    if (!bytes || bytes.length === 0) return new SQL.Database()
    const candidate = new SQL.Database(bytes)
    try {
      // 老实现每 5 秒全量覆盖写，崩溃/断电会留下半截文件；
      // 发现读不动就备份后重建，否则整个代理会因为一个坏文件起不来。
      candidate.exec('SELECT count(*) FROM sqlite_master')
      return candidate
    } catch (e) {
      const backup = `${dbPath}.corrupt-${Date.now()}`
      logger.error(`数据库文件损坏（${e.message}），已备份到 ${backup} 并重建空库`)
      try { fs.renameSync(dbPath, backup) } catch { /* 备份失败也要继续 */ }
      try { candidate.close() } catch { /* 忽略 */ }
      return new SQL.Database()
    }
  }

  function removeStaleTempFiles (target) {
    try {
      const dir = path.dirname(target)
      const prefix = path.basename(target) + '.tmp-'
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue
        const full = path.join(dir, name)
        const st = statOf(full)
        if (st && Date.now() - st.mtimeMs > TEMP_FILE_TTL_MS) { try { fs.unlinkSync(full) } catch { /* 忽略 */ } }
      }
    } catch { /* 目录读不到就跳过清理 */ }
  }

  function assertReady () {
    if (closed) throw new Error('数据库已关闭')
    if (!ready || !db) throw new Error('sql.js 驱动尚未初始化，请先 await ready()')
  }

  function allRows (sql, params) {
    assertReady()
    const stmt = db.prepare(sql)
    try {
      if (params !== undefined && params !== null) stmt.bind(params)
      const rows = []
      // getAsObject() 必须先 step() 才有效，否则拿到的是一行全 null
      while (stmt.step()) rows.push(stmt.getAsObject())
      return rows
    } finally {
      stmt.free()
    }
  }

  function execOn (target, sql, params) {
    if (params === undefined || params === null) target.run(sql)
    else target.run(sql, params)
  }

  function acquireLock () {
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const fd = fs.openSync(lockPath, 'wx')
        try { fs.writeSync(fd, String(process.pid)) } catch { /* 写 pid 只为方便排查 */ }
        fs.closeSync(fd)
        return () => { try { fs.unlinkSync(lockPath) } catch { /* 已被接管 */ } }
      } catch (e) {
        if (e.code !== 'EEXIST') {
          logger.warn(`获取数据库写锁失败: ${e.message}`)
          return () => {}
        }
        const st = statOf(lockPath)
        if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          logger.warn('发现陈旧的数据库写锁，已接管')
          try { fs.unlinkSync(lockPath) } catch { /* 忽略 */ }
          continue
        }
        if (Date.now() >= deadline) {
          logger.warn('等待数据库写锁超时，继续写入')
          return () => {}
        }
        sleepSync(20)
      }
    }
  }

  function writeAtomically (bytes) {
    const tmp = `${dbPath}.tmp-${process.pid}-${Date.now()}`
    try {
      fs.writeFileSync(tmp, bytes)
      for (let i = 0; i < RENAME_RETRY; i++) {
        try {
          // rename 是原子替换：磁盘上要么是旧库要么是新库，不会留下写了一半的库
          fs.renameSync(tmp, dbPath)
          return
        } catch (e) {
          if (i === RENAME_RETRY - 1) {
            // Windows 上目标文件被别的进程打开时 rename 会失败，退化成覆盖写总比丢数据好
            logger.warn(`原子替换失败（${e.code || e.message}），退化为直接写入`)
            fs.writeFileSync(dbPath, bytes)
            return
          }
          sleepSync(20)
        }
      }
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* 忽略 */ }
    }
  }

  function persist () {
    if (!ready || !db || closed) return
    const release = acquireLock()
    try {
      const diskStat = statOf(dbPath)
      // 磁盘文件在上次加载之后被别的实例改过：先读回来，再重放我们自己的写入，
      // 否则我们的 export 会把对方的数据整体覆盖（P1-4 的丢数据根因）。
      if (diskStat && (!lastLoad || diskStat.mtimeMs !== lastLoad.mtimeMs || diskStat.size !== lastLoad.size)) {
        const merged = loadFromDisk()
        for (const sql of ddl) {
          try { merged.exec(sql) } catch (e) { logger.warn(`合并时重建表结构失败: ${e.message}`) }
        }
        for (const write of journal) {
          try { execOn(merged, write.sql, write.params) } catch (e) { logger.warn(`合并重放失败: ${e.message}`) }
        }
        const stale = db
        db = merged
        try { stale.close() } catch { /* 忽略 */ }
      }
      writeAtomically(db.export())
      journal.length = 0
      lastLoad = statOf(dbPath)
    } finally {
      release()
    }
  }

  return {
    driverName: SQL_JS,
    path: dbPath,
    // 写入先落在内存库，必须显式 flush 才落盘 —— 这是与 node:sqlite 的关键差别
    isPersistent: false,
    ready: () => readyPromise,
    run (sql, params) {
      assertReady()
      execOn(db, sql, params)
      const changes = Number(db.getRowsModified()) || 0
      journal.push({ sql, params })
      return { changes }
    },
    all: allRows,
    get (sql, params) {
      const rows = allRows(sql, params)
      return rows.length > 0 ? rows[0] : undefined
    },
    exec (sql) {
      assertReady()
      ddl.push(sql)
      db.exec(sql)
    },
    flush () { persist() },
    close () {
      if (closed) return
      // 必须先落盘再置 closed：否则最后一批请求只留在内存里
      try { persist() } catch (e) { logger.warn(`关闭前落盘失败: ${e.message}`) }
      closed = true
      ready = false
      try { if (db) db.close() } catch (e) { logger.warn(`关闭数据库失败: ${e.message}`) }
      db = null
    },
  }
}

module.exports = { openDatabase, availableDrivers, NODE_SQLITE, SQL_JS }
