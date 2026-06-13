class ServiceContainer {
  constructor() {
    this._factories = new Map()
    this._singletons = new Map()
  }

  register(name, factory, { singleton = false } = {}) {
    this._factories.set(name, { factory, singleton })
  }

  resolve(name) {
    const reg = this._factories.get(name)
    if (!reg) throw new Error(`Service not registered: ${name}`)
    if (reg.singleton) {
      if (!this._singletons.has(name)) {
        this._singletons.set(name, reg.factory(this))
      }
      return this._singletons.get(name)
    }
    return reg.factory(this)
  }

  has(name) { return this._factories.has(name) }

  clear() {
    this._factories.clear()
    this._singletons.clear()
  }
}

module.exports = { ServiceContainer }
