// FIX-04：预算判定
//
// 原实现里 budget_limit / warning_threshold / critical_threshold 只被 UI 与
// 配置文件读写，没有任何判定逻辑。这里给出唯一判定入口，供代理（硬拦截）
// 与主进程（告警推送）共用。

const LEVELS = ['ok', 'warning', 'critical', 'exceeded']

function toPositiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * @param {number} spent 本周期已花费（美元）
 * @param {{budget_limit?:number, warning_threshold?:number, critical_threshold?:number, enforce_budget?:boolean}} cfg
 * @returns {{level:string, spent:number, limit:number, ratio:number, allowed:boolean, enforce:boolean, reason?:string}}
 */
function evaluateBudget(spent, cfg = {}) {
  const safeSpent = Number.isFinite(Number(spent)) && Number(spent) > 0 ? Number(spent) : 0
  const limit = toPositiveNumber(cfg.budget_limit, 0)
  const warnPct = toPositiveNumber(cfg.warning_threshold, 75)
  const critPct = toPositiveNumber(cfg.critical_threshold, 90)
  const enforce = cfg.enforce_budget === true

  if (limit <= 0) {
    return { level: 'ok', spent: safeSpent, limit: 0, ratio: 0, allowed: true, enforce }
  }

  const ratio = safeSpent / limit
  let level = 'ok'
  if (ratio >= 1) level = 'exceeded'
  else if (ratio >= critPct / 100) level = 'critical'
  else if (ratio >= warnPct / 100) level = 'warning'

  // 「到额即拒」：只有显式打开 enforce_budget 才会硬拦截，避免升级后静默断服
  const allowed = !(enforce && level === 'exceeded')

  return {
    level, spent: safeSpent, limit, ratio, allowed, enforce,
    reason: allowed ? undefined : `Budget limit exceeded: ${safeSpent.toFixed(4)} / ${limit.toFixed(4)} USD`,
  }
}

class BudgetGuard {
  /**
   * @param {{ configManager:object, getSpent:()=>number, onLevelChange?:(state:object)=>void }} deps
   */
  constructor({ configManager, getSpent, onLevelChange } = {}) {
    this.configManager = configManager
    this.getSpent = getSpent || (() => 0)
    this.onLevelChange = onLevelChange || null
    this._lastLevel = null
    this._lastNotifiedLevel = null
  }

  _monitorConfig() {
    if (!this.configManager) return {}
    if (typeof this.configManager.reload === 'function') {
      try { this.configManager.reload() } catch { /* 配置读取失败时沿用旧值 */ }
    }
    return typeof this.configManager.getMonitorConfig === 'function'
      ? this.configManager.getMonitorConfig()
      : (this.configManager.config?.monitor || {})
  }

  state() {
    return evaluateBudget(this.getSpent(), this._monitorConfig())
  }

  /** 供代理在处理请求前调用 */
  check() { return this.state() }

  /** 记录一次请求完成后重新评估，仅在等级变化时回调 */
  notify() {
    const state = this.state()
    this._lastLevel = state.level
    if (state.level !== this._lastNotifiedLevel) {
      this._lastNotifiedLevel = state.level
      if (this.onLevelChange) { try { this.onLevelChange(state) } catch { /* UI 回调不应影响代理 */ } }
    }
    return state
  }
}

module.exports = { evaluateBudget, BudgetGuard, LEVELS }
