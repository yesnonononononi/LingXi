import type { AgentEvent } from '../../types/Event';
import { AgentAPI } from '../../services/agent';
import { readSseStream } from '../../services/sse';
import { toAgentEvent } from './agentEventNarrowing';

/** 掉线后重挂的最大尝试次数（有界，避免无限重连）。 */
const MAX_RECONNECT_ATTEMPTS = 5;
/** 掉线后重挂的间隔（毫秒）。 */
const RECONNECT_DELAY_MS = 1000;
/**
 * 心跳静默阈值：后端每 30s 发一帧 HEARTBEAT，取两个周期。
 *
 * <p>超过阈值没收到任何帧即视为不健康（连接可能已死但浏览器没报错），主动重挂。
 * 阈值必须显著大于心跳周期，否则正常的一次心跳抖动就会被误判掉线。</p>
 */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

/**
 * 传输层信号事件名（后端 {@code SseEventPublisher} 的 {@code SignalEvent}）。
 *
 * <p>它们**不是**框架 {@code AgentEvent}：{@code isAgentEventType} 白名单不认，
 * 必须按事件名在传输层拦下消费，绝不能流进 {@link StreamSessionRouter} 的 dispatch
 * （那里会按业务事件处理）。二者也都不带 {@code metaData}，不能用于根/子会话归属判断。</p>
 */
const SIGNAL_READY = 'READY';
const SIGNAL_HEARTBEAT = 'HEARTBEAT';

/** 会话级连接的健康状态（供界面显式呈现「连接失败」并提供重挂入口）。 */
export type StreamHealthState = 'IDLE' | 'CONNECTING' | 'READY' | 'UNHEALTHY' | 'FAILED';

export interface SessionEventStreamOptions {
  /** 收窄后的业务事件出口（已排除 READY / HEARTBEAT 等传输层信号）。 */
  onEvent: (event: AgentEvent) => void;
  /** 连接结束（正常关闭 / 掉线）后回读会话权威状态：用于终结对账与「仍挂起则重挂」。 */
  onConnectionClosed: (sessionId: string) => Promise<void> | void;
  /**
   * 重连成功（**第二次及以后**收到 READY）时回调一次。
   *
   * <p>断线期间服务端不补发事件，唯一对齐入口就是这里触发的历史回查。</p>
   */
  onResubscribed?: (rootSessionId: string) => Promise<void> | void;
  /** 连接健康状态变化时回调，供界面呈现「连接失败」并给出重挂入口。 */
  onHealthChange?: (rootSessionId: string, state: StreamHealthState) => void;
  /** 定时器调度器（宿主注入以便统一取消）。不注入则退回全局 setTimeout。 */
  scheduleRetry?: (handler: () => void, delayMs: number) => number;
  /** 取消定时器。 */
  cancelRetry?: (timerId: number) => void;
  /** 心跳静默阈值（毫秒），默认两个心跳周期。 */
  heartbeatTimeoutMs?: number;
  /** 时钟（测试注入，便于验证心跳超时判定）。 */
  now?: () => number;
}

/** 单个根会话的连接状态（引用计数 + 连接生命周期）。 */
interface RootConnection {
  rootSessionId: string;
  /** 使用者数量：主视图与子会话抽屉可能同时看同一会话，归零才 abort。 */
  refCount: number;
  controller: AbortController | null;
  /** 是否已收到 READY：READY 之前不算就绪，发送前必须等它。 */
  ready: boolean;
  /** 最近一帧（任意帧，含 READY / HEARTBEAT）的到达时刻，用于心跳超时判定。 */
  lastFrameAt: number;
  /** 本次掉线后的重挂次数（上限 {@link MAX_RECONNECT_ATTEMPTS}）。 */
  attempts: number;
  /** 是否曾收到过 READY：用于区分「首次就绪」与「重连成功」。 */
  everReady: boolean;
  state: StreamHealthState;
  retryTimer: number | null;
  healthTimer: number | null;
  /** {@link waitUntilReady} 的等待者，就绪或断线时一次性结算。 */
  waiters: Array<(ready: boolean) => void>;
}

/**
 * 会话级实时事件流（{@code GET /a/completion/{sessionId}/events}）的连接管理器。
 *
 * <p><b>按根会话共享 + 引用计数</b>：后端 {@code SseEventPublisher} 按 rootSessionId 分桶、
 * 把事件推给桶内**全部**流。同一客户端若对同一根会话开出两条连接，同一事件会被双投，
 * 而正文是增量追加 —— 双投即正文双写。因此本类保证「一个客户端对同一 rootSessionId 只有一条连接」：
 * 主视图与子会话抽屉各持一个引用，最后一个使用者释放时才 abort。
 * 键必须是<b>根</b>会话 id：看子会话时另开一条连到同一根桶的流就会双投。</p>
 *
 * <p><b>就绪握手</b>：连接建立后服务端立即发一帧命名事件 {@code READY}（emitter 先入桶再发帧），
 * 因此「收到 READY」等价于「已订阅成功」。发送前必须 {@link waitUntilReady} 等到它，
 * 否则受理落库的行不会推给任何流。</p>
 *
 * <p><b>健康判定</b>：每收到任意一帧就刷新时间戳；超过两个心跳周期（60s）没有任何帧即视为不健康并重挂。
 * 终态<b>不</b>关流（新模型下流跟页面走，完成/失败/停止都只改执行状态），
 * 连接关闭只发生在：引用计数归零、显式 {@link reconnect}、或底层断开。</p>
 */
export class SessionEventStream {
  private readonly options: SessionEventStreamOptions;
  private readonly connections = new Map<string, RootConnection>();
  private readonly heartbeatTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: SessionEventStreamOptions) {
    this.options = options;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 声明一个使用者开始关注该根会话；同一根会话的第二个使用者复用同一条连接。
   *
   * <p>连接已断（refCount 仍 > 0 但无 controller）时立即补挂，不消耗重试预算 ——
   * 使用者还挂着说明这条连接本来就该在。</p>
   */
  public acquire(rootSessionId: string | null | undefined): void {
    if (!rootSessionId) return;
    const key = String(rootSessionId);

    const existing = this.connections.get(key);
    if (existing) {
      existing.refCount += 1;
      if (!existing.controller && existing.retryTimer === null && existing.state !== 'FAILED') {
        this.open(existing);
      }
      return;
    }

    const connection: RootConnection = {
      rootSessionId: key,
      refCount: 1,
      controller: null,
      ready: false,
      lastFrameAt: this.now(),
      attempts: 0,
      everReady: false,
      state: 'IDLE',
      retryTimer: null,
      healthTimer: null,
      waiters: [],
    };
    this.connections.set(key, connection);
    this.open(connection);
  }

  /**
   * 声明一个使用者停止关注该根会话；计数归零才 abort。
   *
   * <p>「一个卸载不 abort」是硬要求：子会话抽屉关闭时主视图还在看同一条连接。</p>
   */
  public release(rootSessionId: string | null | undefined): void {
    if (!rootSessionId) return;
    const connection = this.connections.get(String(rootSessionId));
    if (!connection) return;

    connection.refCount -= 1;
    if (connection.refCount > 0) return;

    this.connections.delete(connection.rootSessionId);
    this.clearTimers(connection);
    connection.controller?.abort();
    connection.controller = null;
    connection.ready = false;
    this.flushWaiters(connection, false);
    this.setState(connection, 'IDLE');
  }

  /** 最近一次 acquire 的、仍存活的根会话 id（发送链路据此确认「发的就是这个连接的会话」）。 */
  public currentRootId(): string | null {
    let latest: string | null = null;
    this.connections.forEach((_connection, key) => { latest = key; });
    return latest;
  }

  /**
   * 等到「已订阅且就绪」（收到 READY）。
   *
   * <p>发送前必须 await 它：READY 之前提交，受理落库那批事件会推给空桶被丢弃。
   * 超时返回 false，由调用方决定重挂后重试还是显式报错。</p>
   */
  public async waitUntilReady(timeoutMs: number): Promise<boolean> {
    const connection = this.resolveCurrentConnection();
    if (!connection) return false;
    if (connection.ready) return true;
    if (connection.state === 'FAILED') return false;

    return new Promise<boolean>((resolve) => {
      let timerId: number | null = null;
      let settled = false;
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        if (timerId !== null) this.cancel(timerId);
        resolve(ready);
      };
      connection.waiters.push(finish);
      timerId = this.schedule(() => {
        connection.waiters = connection.waiters.filter(w => w !== finish);
        finish(false);
      }, timeoutMs);
    });
  }

  /**
   * 显式重挂：丢弃全部连接并立即重建（引用计数保持不变）。
   *
   * <p>重试耗尽后的恢复入口，刻意不做无条件自动恢复 —— 界面必须显式呈现「连接失败」，
   * 让用户决定；同时触发一次历史回查，把断线期间的缺口补回来。</p>
   */
  public reconnect(): void {
    this.connections.forEach((connection) => {
      connection.attempts = 0;
      this.clearTimers(connection);
      this.setState(connection, 'IDLE');
      const controller = connection.controller;
      connection.controller = null;
      connection.ready = false;
      controller?.abort();
      this.flushWaiters(connection, false);
      void this.options.onConnectionClosed(connection.rootSessionId);
      this.open(connection);
    });
  }

  /** 释放全部连接（组件卸载）。 */
  public close(): void {
    Array.from(this.connections.keys()).forEach(key => this.release(key));
  }

  /** 当前是否有活跃连接（观测 / 测试用）。 */
  public isConnected(): boolean {
    let connected = false;
    this.connections.forEach((connection) => { if (connection.controller) connected = true; });
    return connected;
  }

  /** 当前连接是否已收到 READY（观测 / 测试用）。 */
  public isReady(): boolean {
    return this.resolveCurrentConnection()?.ready === true;
  }

  /** 当前连接健康状态（观测 / 测试用）。 */
  public getHealthState(): StreamHealthState {
    return this.resolveCurrentConnection()?.state ?? 'IDLE';
  }

  /** 某根会话的引用计数（测试用：验证共享连接与「一个卸载不 abort」）。 */
  public resolveRefCount(rootSessionId: string): number {
    return this.connections.get(String(rootSessionId))?.refCount ?? 0;
  }

  /* ---------------------------------------------------------------- */
  /* 内部实现                                                          */
  /* ---------------------------------------------------------------- */

  private resolveCurrentConnection(): RootConnection | null {
    const key = this.currentRootId();
    return key ? this.connections.get(key) ?? null : null;
  }

  private open(connection: RootConnection): void {
    if (this.connections.get(connection.rootSessionId) !== connection) return;
    if (connection.controller) return;

    const controller = new AbortController();
    connection.controller = controller;
    connection.ready = false;
    connection.lastFrameAt = this.now();
    this.setState(connection, 'CONNECTING');
    void this.read(connection, controller);
  }

  private async read(connection: RootConnection, controller: AbortController): Promise<void> {
    let response: Response;
    try {
      response = await AgentAPI.subscribeSessionEvents(connection.rootSessionId, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.warn('[SessionEventStream] 建立会话事件流失败:', err);
      await this.handleDrop(connection, controller);
      return;
    }
    if (this.connections.get(connection.rootSessionId) !== connection) return;
    if (connection.controller !== controller) return;

    await readSseStream(response, {
      signal: controller.signal,
      onEvent: (raw) => this.consumeFrame(connection, raw.event, raw.data),
    });
    await this.handleDrop(connection, controller);
  }

  /**
   * 消费一帧：先按事件名拦下传输层信号，再把业务事件收窄转出。
   *
   * <p>顺序不可反：READY / HEARTBEAT 若放进 {@link toAgentEvent} 之后就会以「未知事件」
   * 被静默丢弃，READY 永远不会置位，发送前的就绪等待必然超时。</p>
   */
  private consumeFrame(connection: RootConnection, eventName: string, data: unknown): void {
    connection.lastFrameAt = this.now();

    if (eventName === SIGNAL_READY) {
      this.markReady(connection);
      return;
    }
    if (eventName === SIGNAL_HEARTBEAT) {
      return;
    }

    const event = toAgentEvent({
      event: eventName,
      data: data as never,
      raw: '',
    });
    if (!event || !event.data) {
      console.debug('[SessionEventStream] 未知事件已忽略', connection.rootSessionId, eventName);
      return;
    }
    this.options.onEvent(event.data);
  }

  private markReady(connection: RootConnection): void {
    const resubscribed = connection.everReady;
    connection.ready = true;
    connection.everReady = true;
    connection.attempts = 0;
    connection.lastFrameAt = this.now();
    this.setState(connection, 'READY');
    this.flushWaiters(connection, true);
    this.armHealthCheck(connection);
    if (resubscribed) {
      void this.options.onResubscribed?.(connection.rootSessionId);
    }
  }

  /** 心跳静默超时即视为不健康：主动断开并走重挂（与掉线同一条收口路径）。 */
  private armHealthCheck(connection: RootConnection): void {
    this.clearHealthTimer(connection);
    if (!this.options.scheduleRetry) return;
    connection.healthTimer = this.options.scheduleRetry(() => {
      connection.healthTimer = null;
      if (this.connections.get(connection.rootSessionId) !== connection) return;
      if (!connection.controller) return;
      if (this.isHealthy(connection)) {
        this.armHealthCheck(connection);
        return;
      }
      console.warn('[SessionEventStream] 心跳超时，判定连接不健康并重挂:', connection.rootSessionId);
      this.setState(connection, 'UNHEALTHY');
      const controller = connection.controller;
      controller.abort();
      void this.handleDrop(connection, controller);
    }, this.heartbeatTimeoutMs);
  }

  private isHealthy(connection: RootConnection): boolean {
    return connection.ready && this.now() - connection.lastFrameAt <= this.heartbeatTimeoutMs;
  }

  /**
   * 连接结束的统一收口：先回读权威状态，再按引用计数决定是否重挂。
   *
   * <p>回读后调用方可能已释放该会话（切走 / 卸载），此时不再重挂。</p>
   */
  private async handleDrop(connection: RootConnection, controller: AbortController): Promise<void> {
    if (connection.controller !== controller) return; // 已被别的路径收口
    if (this.connections.get(connection.rootSessionId) !== connection) return; // 主动释放：不回读、不重挂

    connection.controller = null;
    connection.ready = false;
    this.clearHealthTimer(connection);
    this.flushWaiters(connection, false);

    await this.options.onConnectionClosed(connection.rootSessionId);
    if (this.connections.get(connection.rootSessionId) !== connection) return;
    if (connection.controller) return;
    this.scheduleReconnect(connection);
  }

  private scheduleReconnect(connection: RootConnection): void {
    if (!this.options.scheduleRetry) return;
    if (connection.attempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[SessionEventStream] 会话事件流重挂已达上限，停止重连:', connection.rootSessionId);
      this.setState(connection, 'FAILED');
      return;
    }
    connection.attempts += 1;
    connection.retryTimer = this.options.scheduleRetry(() => {
      connection.retryTimer = null;
      if (this.connections.get(connection.rootSessionId) !== connection) return;
      if (connection.controller) return;
      this.open(connection);
    }, RECONNECT_DELAY_MS);
  }

  private setState(connection: RootConnection, state: StreamHealthState): void {
    if (connection.state === state) return;
    connection.state = state;
    this.options.onHealthChange?.(connection.rootSessionId, state);
  }

  private flushWaiters(connection: RootConnection, ready: boolean): void {
    if (connection.waiters.length === 0) return;
    const waiters = connection.waiters;
    connection.waiters = [];
    waiters.forEach(waiter => waiter(ready));
  }

  private clearTimers(connection: RootConnection): void {
    this.clearHealthTimer(connection);
    if (connection.retryTimer !== null) {
      this.cancel(connection.retryTimer);
      connection.retryTimer = null;
    }
  }

  private clearHealthTimer(connection: RootConnection): void {
    if (connection.healthTimer === null) return;
    this.cancel(connection.healthTimer);
    connection.healthTimer = null;
  }

  /** 定时器调度：优先用宿主注入的（便于组件卸载统一清理与测试手动驱动）。 */
  private schedule(handler: () => void, delayMs: number): number {
    if (this.options.scheduleRetry) return this.options.scheduleRetry(handler, delayMs);
    return globalThis.setTimeout(handler, delayMs) as unknown as number;
  }

  private cancel(timerId: number): void {
    if (this.options.cancelRetry) {
      this.options.cancelRetry(timerId);
      return;
    }
    globalThis.clearTimeout(timerId);
  }
}