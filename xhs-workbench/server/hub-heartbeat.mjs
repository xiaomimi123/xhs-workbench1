// 工作台开着就向企业中枢报到（控制台「在线」据此显示）。
//
// 背景：员工现在主要从桌面图标打开工作台，由工作台拉起 CodeBuddy（嵌套模式，接入器的桥不报心跳）。员工整天在工作台里做事，
// 中枢却看不到他在线（总览「在线 agent」常年是 0）。所以工作台自己每分钟报到一次，用的是接入器给的同一个令牌。
//
// 只在「有人在看」时报到：网页开着（有实时连接）。工作台服务本身常驻后台，不能拿「进程活着」当在线。
// 报到不带 client / version / os：中枢会保留接入器上报的值（version 是接入器版本，控制台用它判断「是否还在用旧版接入器」，
// 不能被工作台版本号覆盖）。失败一律忽略，不影响工作台。
export class HubHeartbeat {
  constructor({ hubGen, isActive = () => true, fetchImpl = globalThis.fetch, intervalMs = 60_000, firstDelayMs = 5_000 } = {}) {
    Object.assign(this, { hubGen, isActive, fetch: fetchImpl, intervalMs, firstDelayMs, timer: null, first: null });
  }

  /** 报一次。返回结果说明（便于测试 / 排查）：idle 没人在看、no-hub 没接中枢、ok、http-<状态码>、error */
  async beat() {
    if (!this.isActive()) return 'idle';
    if (!this.hubGen?.available?.()) return 'no-hub';
    try {
      let status = await this.#post(false);
      if (status === 401) status = await this.#post(true);   // 令牌过期：换一个再试一次
      return status >= 200 && status < 300 ? 'ok' : `http-${status}`;
    } catch {
      return 'error';
    }
  }

  async #post(forceToken) {
    const t = await this.hubGen.token(forceToken);
    const res = await this.fetch(`${String(t.hub).replace(/\/+$/, '')}/api/agent/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.access_token}` },
      body: '{}',
      signal: AbortSignal.timeout(8_000),
    });
    return res.status;
  }

  start() {
    if (this.timer) return;
    this.first = setTimeout(() => this.beat(), this.firstDelayMs);
    this.first.unref?.();
    this.timer = setInterval(() => this.beat(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.first = this.timer = null;
  }
}
