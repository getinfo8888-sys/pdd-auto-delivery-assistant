'use strict';

// A healthy SDK does not imply that its surrounding document recovered.
// Refresh once per observed offline/online transition, after a stable interval.
class NetworkRefresh {
  constructor({ refresh, update = () => {}, settleMs = 5000, retryMs = 15000, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    this.refresh = refresh; this.update = update; this.settleMs = settleMs; this.retryMs = retryMs;
    this.now = now; this.schedule = schedule; this.cancel = cancel;
    this.online = null; this.generation = 0; this.cycle = 0; this.timer = null; this.disposed = false;
    this.state = { phase: 'idle', online: null, cycle: 0 };
  }
  publish(value) { this.state = { online: this.online, cycle: this.cycle, ...value }; this.update(this.state); }
  observe(online) {
    if (this.disposed || typeof online !== 'boolean' || online === this.online) return;
    const previous = this.online; this.online = online; this.generation++;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (!online) { this.cycle++; this.publish({ phase: 'offline', at: this.now() }); return; }
    if (previous === null) { this.publish({ phase: 'online' }); return; }
    const generation = this.generation, onlineAt = this.now();
    this.publish({ phase: 'stabilizing', onlineAt, refreshAt: onlineAt + this.settleMs });
    this.timer = this.schedule(() => { this.timer = null; void this.run(generation, onlineAt, 1); }, this.settleMs);
  }
  async run(generation, onlineAt, attempt) {
    const isCurrent = () => !this.disposed && this.online && generation === this.generation;
    if (!isCurrent()) return;
    this.publish({ phase: 'refreshing', onlineAt, attempt });
    try {
      const result = await this.refresh({ cycle: this.cycle, onlineAt, isCurrent });
      if (!isCurrent()) return;
      if (result?.deferred && attempt < 3) {
        this.publish({ phase: 'waiting', onlineAt, attempt, retryAt: this.now() + this.retryMs });
        this.timer = this.schedule(() => { this.timer = null; void this.run(generation, onlineAt, attempt + 1); }, this.retryMs);
      } else this.publish({ phase: result?.deferred || result?.failed ? 'failed' : 'complete', onlineAt, finishedAt: this.now(), attempt, pages: result?.pages || [] });
    } catch {
      if (isCurrent()) this.publish({ phase: 'failed', onlineAt, finishedAt: this.now(), attempt });
    }
  }
  dispose() {
    this.disposed = true; this.generation++;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
}
module.exports = { NetworkRefresh };
