'use strict';

// Boot intent is separate from saved running state. A manual pause cancels this
// boot's retries, while a future launch may connect again using the saved option.
class StartupListener {
  constructor({ start, update = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
    this.start = start; this.update = update; this.schedule = schedule; this.cancel = cancel;
    this.generation = 0; this.timer = null; this.active = false; this.attempt = 0;
    this.state = { phase: 'idle', pending: false };
  }
  publish(value) { this.state = { ...value, pending: this.active }; this.update(this.state); }
  arm(config, { recovery = false } = {}) {
    this.stop('idle');
    if (!config.autoListenOnLaunch && !recovery) return;
    this.active = true; this.attempt = 0; this.recovery = recovery;
    void this.run(this.generation);
  }
  recover(config) {
    if (!this.active) this.arm(config, { recovery: true });
  }
  stop(phase = 'paused') {
    this.generation++; this.active = false;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null; this.publish({ phase });
  }
  async run(generation) {
    if (!this.active || generation !== this.generation) return;
    this.publish({ phase: this.recovery ? 'reconnecting' : 'connecting', message: this.recovery ? '正在恢复官方页面与发送连接' : '正在自动连接官方页面' });
    try {
      await this.start();
      if (generation !== this.generation) return;
      this.active = false; this.publish({ phase: 'listening', message: '已自动开始监听' });
    } catch (error) {
      if (!this.active || generation !== this.generation) return;
      const message = String(error.message || '连接失败');
      const phase = /离线|网络未连接/.test(message) ? 'offline' : /滑块|安全验证/.test(message) ? 'verification' : /登录已过期|扫码|请先.*登录/.test(message) ? 'login' : 'retrying';
      const delay = Math.min(30000, 3000 * 2 ** Math.min(this.attempt++, 4));
      this.publish({ phase, message, kind: /订单/.test(message) ? 'orders' : 'chat', retryAt: Date.now() + delay });
      this.timer = this.schedule(() => { this.timer = null; void this.run(generation); }, delay);
    }
  }
}

module.exports = { StartupListener };
