// global-state.js
class GlobalState {
  #sessions = {}
  #upgradeInsts = {}
  #authed = false

  // Sessions management
  getSession (id) {
    return this.#sessions[id]
  }

  setSession (id, data) {
    this.#sessions[id] = data
  }

  removeSession (id) {
    delete this.#sessions[id]
  }

  // Upgrade instances management
  getUpgradeInst (id) {
    return this.#upgradeInsts[id]
  }

  setUpgradeInst (id, inst) {
    this.#upgradeInsts[id] = inst
  }

  removeUpgradeInst (id) {
    delete this.#upgradeInsts[id]
  }

  get authed () {
    return this.#authed
  }

  set authed (val) {
    this.#authed = val
  }

  get data () {
    return {
      sessions: this.#sessions,
      upgradeInsts: this.#upgradeInsts,
      authed: this.#authed
    }
  }
}

// Export a singleton instance
module.exports = new GlobalState()
