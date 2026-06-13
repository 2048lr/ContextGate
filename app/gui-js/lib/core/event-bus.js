class EventBus {
  constructor() { this._listeners = new Map() }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event).add(fn)
    return () => this.off(event, fn)
  }

  off(event, fn) {
    const set = this._listeners.get(event)
    if (set) set.delete(fn)
  }

  emit(event, data) {
    const set = this._listeners.get(event)
    if (!set) return
    for (const fn of set) {
      try { fn(data) } catch (e) { console.error(`EventBus error [${event}]:`, e) }
    }
  }

  once(event, fn) {
    const wrapper = (data) => { this.off(event, wrapper); fn(data) }
    this.on(event, wrapper)
  }

  clear() { this._listeners.clear() }
}

module.exports = { EventBus }
