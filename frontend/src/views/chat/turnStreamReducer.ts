import type { AgentEvent, TokenInfo } from '../../types/Event';
import type { BlockEventPayload } from '../../types/block';
import { parseVersion } from '../../types/block';
import type { ChatMessage, ContextUsageData, ToolCallVO } from '../../types/chat';
import { isCardToolName, upsertPromptCard } from '../../utils/toolCallCard';
import { projectTurnView, upsertBlockIntoBubble } from './blockProjection';

/** 卡片就绪重试上限（次）。 */
const CARD_RETRY_MAX = 5;
/** 卡片就绪重试间隔（毫秒）。 */
const CARD_RETRY_DELAY_MS = 400;

export interface TurnStreamReducerOptions {
  sessionId: string;
  onScrollFollow?: () => void;
  onContextUsageUpdate?: (sessionId: string, usage: ContextUsageData) => void;
  /**
   * 按 toolCallId 拉取权威 {@link ToolCallVO}（卡片唯一权威数据源）。
   *
   * <p>实时路径收到 PROMISE 类工具调用 / EXECUTION_SUSPENDED 时回调它建卡。返回 null 表示
   * 「查不到」（不建卡、不伪造）；抛异常表示「查失败」（同样不建卡，由后续事件/对账重试）。</p>
   */
  onResolveCard?: (toolCallId: string) => Promise<ToolCallVO | null>;
  /**
   * 卡片就绪前的有界重试调度器：由宿主注入，便于组件卸载时统一取消。
   *
   * <p>不注入则不做重试（保持「单次拉取」：测试 / 无定时器宿主）。这是**安全网**而非主修复：
   * 框架现已保证 {@code PREPARING → PENDING} 先于 SSE 挂起事件完成，正常路径首次拉取即就绪；
   * 重试只兜「事件与落库之间偶发的可见性延迟 / 乱序」，避免卡在拉到的旧 {@code PREPARING}
   * 快照上、永远停在「准备中」。</p>
   */
  scheduleCardRetry?: (handler: () => void, delayMs: number) => number;
  /** 取消 {@link scheduleCardRetry} 返回的定时器。 */
  cancelCardRetry?: (timerId: number) => void;
}

/**
 * 业务轮次流式渲染状态机。
 *
 * <p><b>展示内容的唯一来源是块视图</b>：{@code TURN_SNAPSHOT} 整轮重投影、{@code BLOCK_UPSERT}
 * 按 blockId 增量。原始事件（{@code PARTIAL_*} / {@code TOOL_*}）<b>不再写气泡内容</b> ——
 * 它们只用于两件事：推进轮次/气泡的生命周期（进行中 / 挂起 / 终结），以及驱动审批卡片拉取。</p>
 *
 * <p>这样前端完全不参与「时序与状态推断」：正文、思考分步、工具条顺序与状态全部读后端
 * 的 {@code order / placement / status}。</p>
 */
export class TurnStreamReducer {
  private sessionId: string;
  /**
   * 消息数组访问器：每次读写都取「当前」数组。
   *
   * <p>会话对账 / 分页加载会整体替换 {@code session.messages} 引用；若在构造时捕获裸数组，
   * 后续 push / 查找都落在已脱离渲染的旧数组上（表现为「新用户气泡不可见，直到下一轮
   * 对账把数组换回来才与回答一起出现」）。改为访问器后始终作用于最新数组。</p>
   */
  private getMessages: () => ChatMessage[];
  private currentTurnId: string | null = null;
  private activeBubbleId: string | null = null;
  private onScrollFollow?: () => void;
  private onContextUsageUpdate?: (sessionId: string, usage: ContextUsageData) => void;
  private onResolveCard?: (toolCallId: string) => Promise<ToolCallVO | null>;
  private scheduleCardRetry?: (handler: () => void, delayMs: number) => number;
  private cancelCardRetry?: (timerId: number) => void;
  /** 待重试的建卡定时器：toolCallId → timerId（可取消）。 */
  private cardRetryTimers = new Map<string, number>();
  /** 正在拉取中的 toolCallId（防并发/重复触发叠加定时器）。 */
  private cardResolving = new Set<string>();
  /** 已释放标记：释放后不再创建重试。 */
  private disposed = false;
  /**
   * 每轮已渲染到的块视图版本号（{@code viewVersion}）。
   *
   * <p>只用于 {@code TURN_SNAPSHOT} 的乱序拦截：拿到更小的版本即丢弃。
   * {@code BLOCK_UPSERT} 刻意**不**参与比较 —— 工具收尾不改 chat_turn，同轮多次增量版本号相等。</p>
   */
  private turnViewVersions = new Map<string, number>();

  constructor(messages: ChatMessage[] | (() => ChatMessage[]), options: TurnStreamReducerOptions) {
    // 兼容两种入参：裸数组（测试 / 旧调用）与访问器（绑定「当前」数组）
    this.getMessages = typeof messages === 'function' ? messages : () => messages;
    this.sessionId = options.sessionId;
    this.onScrollFollow = options.onScrollFollow;
    this.onContextUsageUpdate = options.onContextUsageUpdate;
    this.onResolveCard = options.onResolveCard;
    this.scheduleCardRetry = options.scheduleCardRetry;
    this.cancelCardRetry = options.cancelCardRetry;
  }

  /** 注入用户乐观提问气泡 */
  public pushUserMessage(text: string, imageUrl?: string): ChatMessage {
    const userMessage: ChatMessage = {
      id: `user-${this.sessionId}-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      turnId: null,
      imageUrl
    };
    this.getMessages().push(userMessage);
    this.onScrollFollow?.();
    return userMessage;
  }

  /**
   * 把最后一条尚未绑定轮次的用户气泡绑定到权威 turnId。
   *
   * <p>受理回执返回后调用。乐观气泡必须拿到权威 turnId，否则它与历史里的同一条消息
   * 分组键不同，按轮合并时会产生重复用户气泡。</p>
   */
  public bindUserMessageTurn(turnId: string): void {
    if (!turnId) return;
    const messages = this.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'user') continue;
      if (message.turnId == null) message.turnId = turnId;
      return;
    }
  }

  /** 消费运行时事件驱动气泡演进 */
  public consume(event: AgentEvent): void {
    const turnId = event.metaData?.turnId ? String(event.metaData.turnId) : null;
    if (turnId && (!this.currentTurnId || this.currentTurnId !== turnId)) {
      this.currentTurnId = turnId;
    }

    switch (event.type) {
      case 'EXECUTION_STARTED':
        this.handleExecutionStarted(turnId);
        break;

      // 原始增量不写展示内容：正文 / 思考 / 工具条一律等块视图（TURN_SNAPSHOT / BLOCK_UPSERT）。
      // 只保留「本轮仍在生成」这一事实，供气泡运行态与滚动跟随使用。
      case 'PARTIAL_THINKING':
      case 'PARTIAL_TEXT':
        this.handleActivity(turnId);
        break;

      // COMPLETE_TEXT 曾是正文的「全量备份」通道；块视图生效后它与 AI_MESSAGE 一样是噪声。
      case 'COMPLETE_TEXT':
      case 'AI_MESSAGE':
        break;

      // 工具开始 / 结束不再建卡、不写工具条；只按权威数据拉审批卡片（PROMISE 类）。
      case 'TOOL_CALL':
        this.handleToolActivity(turnId, event.requestId, event.toolName);
        break;

      case 'TOOL_COMPLETED':
        this.handleToolCompleted(event);
        break;

      case 'CONTEXT_UPDATE':
        this.handleContextUpdate(event);
        break;

      case 'EXECUTION_SUSPENDED':
        this.handleExecutionSuspended();
        break;

      case 'EXECUTION_RESUME':
        this.handleExecutionResumed();
        break;

      case 'EXECUTION_COMPLETED':
        this.handleExecutionCompleted(event.tokenInfo ?? null);
        break;

      case 'EXECUTION_FAILED':
        this.handleExecutionFailed(event.errMsg);
        break;

      case 'EXECUTION_CANCELLED':
        this.handleExecutionCancelled();
        break;

      case 'TURN_SNAPSHOT':
        this.handleTurnSnapshot(event);
        break;

      case 'BLOCK_UPSERT':
        this.handleBlockUpsert(event);
        break;

      default:
        break;
    }
  }

  /**
   * 整轮权威快照：按 {@code viewVersion} 拦截旧帧，命中则整轮重投影。
   *
   * <p>快照是「校准」——块的身份 / 顺序 / 状态全部来自后端，前端整体重写过程列，
   * 不再自己累加。前端只保留「当前已渲染到的版本号」，更小的版本直接丢弃。</p>
   */
  private handleTurnSnapshot(raw: unknown): void {
    const payload = extractBlockPayload(raw);
    if (!payload) return;
    const turnId = payload.turnId;

    const last = this.turnViewVersions.get(turnId);
    // ⚠️ 必须转数值再比：线上 viewVersion 是十进制字符串，字典序比较下 "10" < "9" 为真。
    const incoming = parseVersion(payload.viewVersion);
    if (last !== undefined && incoming < last) {
      // 乱序到达的旧帧：丢弃，绝不用旧内容覆盖新内容。
      return;
    }
    this.turnViewVersions.set(turnId, incoming);

    const bubble = this.obtainActiveBubble(turnId);
    projectTurnView(bubble, payload.view);
    // 轮次状态是权威的：终态/挂起据此对齐，避免快照到了但气泡还停在「进行中」。
    this.applyTurnStatus(bubble, payload.view.status);
    this.onScrollFollow?.();
  }

  /**
   * 单块增量：按 {@code blockId} 覆盖，**不做版本比较**。
   *
   * <p>⚠️ 增量与快照共用 {@code chat_turn.version} 作批次号，而工具收尾不改 chat_turn ——
   * 同一轮多次 upsert 的版本号必然相等。按版本丢弃会误杀合法增量，故这里只按 blockId 覆盖。</p>
   */
  private handleBlockUpsert(raw: unknown): void {
    const payload = extractBlockPayload(raw);
    if (!payload) return;
    const turnId = payload.turnId;

    // 尚未建立基线（没收到过快照/历史）时，增量无从叠加 —— 交给后续快照或对账补全，
    // 在此凭空造气泡会让「同一轮两条气泡」复发（历史侧还有一条权威的）。
    const bubble = this.findBubbleByTurnId(turnId);
    if (!bubble) return;

    upsertBlockIntoBubble(bubble, payload.view);
  }

  /** 按 turnId 查已存在的助手气泡（不新建）。 */
  private findBubbleByTurnId(turnId: string): ChatMessage | null {
    if (this.activeBubbleId) {
      const active = this.findMessageById(this.activeBubbleId);
      if (active && active.turnId === turnId) return active;
    }
    return this.getMessages().find(m => m.role === 'assistant' && m.turnId === turnId) ?? null;
  }

  /** 轮次状态 → 气泡运行态标志（终态/挂起据此对齐）。 */
  private applyTurnStatus(bubble: ChatMessage, status: string): void {
    switch (status) {
      case 'COMPLETED':
        bubble.isComplete = true;
        bubble.isThinking = false;
        bubble.isExploring = false;
        bubble.isSuspended = false;
        break;
      case 'FAILED':
      case 'CANCELLED':
        bubble.isComplete = true;
        bubble.isThinking = false;
        bubble.isExploring = false;
        bubble.isSuspended = false;
        break;
      case 'WAITING':
        bubble.isSuspended = true;
        bubble.isThinking = false;
        bubble.isExploring = false;
        break;
      case 'RUNNING':
        bubble.isThinking = true;
        bubble.isSuspended = false;
        bubble.isComplete = false;
        break;
      case 'ACCEPTED':
      default:
        break;
    }
  }

  /** 获取或建立当前轮次的聚合助手气泡 */
  private obtainActiveBubble(turnId: string | null): ChatMessage {
    if (this.activeBubbleId) {
      const active = this.findMessageById(this.activeBubbleId);
      if (active && (!turnId || !active.turnId || active.turnId === turnId)) {
        if (turnId && !active.turnId) {
          active.turnId = turnId;
        }
        return active;
      }
    }

    // 检查末尾是否已有同 turnId 或进行中的助手气泡
    if (turnId) {
      const existing = this.getMessages().find(m => m.role === 'assistant' && m.turnId === turnId);
      if (existing) {
        this.activeBubbleId = existing.id;
        return existing;
      }
    }

    // 复用末尾尚未绑 turnId 的进行中助手气泡（例如 EXECUTION_STARTED 或 CONTEXT_UPDATE 先后触发）
    const list = this.getMessages();
    const lastMsg = list.length > 0 ? list[list.length - 1] : null;
    if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isComplete && (!lastMsg.turnId || (turnId && lastMsg.turnId === turnId))) {
      if (turnId && !lastMsg.turnId) {
        lastMsg.turnId = turnId;
      }
      this.activeBubbleId = lastMsg.id;
      return lastMsg;
    }

    const bubbleId = `bubble-${this.sessionId}-${turnId || Date.now()}`;
    const newBubble: ChatMessage = {
      id: bubbleId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      turnId,
      isThinking: true,
      isExploring: true,
      isComplete: false,
      isSuspended: false,
      // 过程列初始为空：内容一律由块视图（TURN_SNAPSHOT / BLOCK_UPSERT）投影写入，
      // 前端不再自己累加，避免与后端 order 漂移。
      thoughtSteps: [],
      toolCalls: [],
      aiMessages: [],
      processTimeline: []
    };

    this.getMessages().push(newBubble);
    this.activeBubbleId = bubbleId;
    this.onScrollFollow?.();
    return newBubble;
  }

  private handleExecutionStarted(turnId: string | null): void {
    const bubble = this.obtainActiveBubble(turnId);
    bubble.isThinking = true;
    bubble.isExploring = true;
    bubble.isSuspended = false;
    bubble.isComplete = false;
  }

  /**
   * 原始增量事件（正文 / 思考）：只标记「本轮仍在生成」。
   *
   * <p>内容本身不写气泡 —— 后端会通过 {@code TURN_SNAPSHOT}（整轮）与 {@code BLOCK_UPSERT}（单块）
   * 下发权威块。这里保留气泡并置为进行中，保证终结事件到达前界面有承载对象。</p>
   */
  private handleActivity(turnId: string | null): void {
    const bubble = this.obtainActiveBubble(turnId);
    bubble.isThinking = true;
    bubble.isExploring = false;
    bubble.isSuspended = false;
    bubble.isComplete = false;
  }

  /**
   * 工具调用开始：不建卡、不写工具条。
   *
   * <p>工具条的内容与状态由后端块视图决定（{@code TOOL} 块）。这里只为 PROMISE 类工具
   * （计划 / 提问 / 命令审批）触发一次权威 {@link ToolCallVO} 拉取 —— 审批卡片是用户必须
   * 立即看到并操作的东西，不能等块视图。</p>
   */
  private handleToolActivity(turnId: string | null, requestId?: string, toolName?: string): void {
    const bubble = this.obtainActiveBubble(turnId);
    bubble.isExploring = false;
    bubble.isSuspended = false;

    if (!requestId || !toolName || !isCardToolName(toolName)) return;

    this.requestPromptCard(bubble.id, requestId, toolName);
    this.onScrollFollow?.();
  }

  private handleToolCompleted(event: {
    requestId?: string;
    toolName?: string;
    output?: string;
    resultStatus?: string;
  }): void {
    // 工具结果不再写工具条：状态与结果文案来自后端 TOOL 块。
    // 但终端审批（命令审批）在 policy 内短路，框架只发 TOOL_COMPLETED(resultStatus=PROMISED)、
    // 从不发 TOOL_CALL，必须用完成事件自带的权威调用 ID 直接拉卡 —— 否则实时审批卡要等到
    // 刷新后从历史聚合才出现。requestId 缺失同样不建卡：伪造 ID 会让卡片挂到错误的调用上。
    if (event.resultStatus !== 'PROMISED' || !event.requestId) return;

    const bubble = this.obtainActiveBubble(this.currentTurnId);
    this.requestPromptCard(bubble.id, event.requestId, event.toolName);
  }

  private handleContextUpdate(event: {
    phase?: string;
    usage?: { tokenCount: number; maxTokens: number; ratio: number } | null;
    message?: string;
  }): void {
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    if (event.phase === 'SQUEEZE_STARTED') {
      bubble.isCompressingContext = true;
    } else if (event.phase === 'SQUEEZE_COMPLETED') {
      bubble.isCompressingContext = false;
    }

    if (event.usage) {
      const usageData: ContextUsageData = {
        phase: event.phase,
        tokenCount: event.usage.tokenCount,
        maxTokens: event.usage.maxTokens,
        ratio: event.usage.ratio,
        message: event.message
      };
      bubble.contextUsage = usageData;
      this.onContextUsageUpdate?.(this.sessionId, usageData);
    }
  }

  private handleExecutionSuspended(): void {
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isThinking = false;
    bubble.isExploring = false;
    bubble.isSuspended = true;

    // 挂起时进行中的工具由后端块视图给出 pending 语义；这里只对 PROMISE 类再拉一次权威卡片兜底。
    if (bubble.toolCalls) {
      bubble.toolCalls.forEach(tc => {
        if (tc.status === 'pending' && isCardToolName(tc.toolName)) {
          this.requestPromptCard(bubble.id, tc.id, tc.toolName);
        }
      });
    }

    this.onScrollFollow?.();
  }

  private handleExecutionResumed(): void {
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isSuspended = false;
    bubble.isThinking = true;

    this.onScrollFollow?.();
  }

  private handleExecutionCompleted(tokenInfo: TokenInfo | null): void {
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isComplete = true;
    bubble.isThinking = false;
    bubble.isExploring = false;
    bubble.isSuspended = false;
    bubble.tokenInfo = tokenInfo ?? undefined;

    // 执行终结：卡片不会再有就绪机会，取消全部待重试定时器
    this.clearAllCardRetries();

    this.activeBubbleId = null;
    this.onScrollFollow?.();
  }

  private handleExecutionFailed(errMsg?: string): void {
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isComplete = true;
    bubble.isThinking = false;
    bubble.isExploring = false;
    bubble.isSuspended = false;
    // 执行终结：卡片不会再有就绪机会，取消全部待重试定时器
    this.clearAllCardRetries();
    // 失败原因写进 content 尾部：该轮不会再有 BODY 块，错误文案只能由实时事件补。
    // 与历史路径同形（刷新后从 turn.errorReason 看到），两处口径一致。
    if (errMsg) {
      bubble.content = bubble.content ? `${bubble.content}\n\n${errMsg}` : errMsg;
    }

    this.activeBubbleId = null;
    this.onScrollFollow?.();
  }

  private handleExecutionCancelled(): void {
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isComplete = true;
    bubble.isThinking = false;
    bubble.isExploring = false;
    bubble.isSuspended = false;

    // 执行终结：卡片不会再有就绪机会，取消全部待重试定时器
    this.clearAllCardRetries();

    this.activeBubbleId = null;
    this.onScrollFollow?.();
  }

  private findMessageById(id: string): ChatMessage | undefined {
    return this.getMessages().find(m => m.id === id);
  }


  /**
   * 请求一次「卡片就绪」拉取（并发/重复触发按 toolCallId 去重，避免定时器叠加）。
   *
   * @param toolName 事件自带的工具名；仅用于日志留痕，不参与建卡判据
   */
  private requestPromptCard(bubbleId: string, toolCallId: string, toolName?: string): void {
    if (this.disposed || !toolCallId) return;
    if (this.cardResolving.has(toolCallId) || this.cardRetryTimers.has(toolCallId)) return;
    void this.resolvePromptCard(bubbleId, toolCallId, toolName, 0);
  }

  /**
   * 拉取权威卡片并挂到气泡上（幂等：按 id 覆盖）。
   *
   * <p>「查不到」「查失败」都**不建卡、不伪造状态**，并纳入有界重试；只有 `type==='PROMISE'`
   * 才建卡。就绪（权威 `pending=true`）或已决（`completed`/`in_progress`）即停止重试。</p>
   *
   * <p>气泡按 id 现查而非持引用：会话对账会整体替换 messages，持有旧引用会写到脱离渲染的对象上。</p>
   */
  private async resolvePromptCard(bubbleId: string, toolCallId: string, toolName: string | undefined, attempt: number): Promise<void> {
    if (this.disposed || !this.onResolveCard || !toolCallId) return;
    if (this.cardResolving.has(toolCallId)) return;
    this.cardResolving.add(toolCallId);

    let card: ToolCallVO | null = null;
    try {
      card = await this.onResolveCard(toolCallId);
    } catch (err) {
      // 查失败同样不建卡；纳入重试（网络抖动不该让卡片永远停在「准备中」）
      console.warn('[TurnStreamReducer] 拉取互动卡片失败，稍后重试（不伪造状态）:', toolName ?? toolCallId, err);
      card = null;
    } finally {
      this.cardResolving.delete(toolCallId);
    }
    if (this.disposed) return;

    if (card && card.type === 'PROMISE') {
      const bubble = this.findMessageById(bubbleId);
      if (bubble) {
        // ⚠️ 落卡走 upsertPromptCard（历史/实时唯一落点）：本地再写一份「覆盖或追加」
        // 就会和历史路径漂移，表现为「实时卡已是新状态、刷新后又变回旧的」。
        upsertPromptCard(bubble, card);
        this.onScrollFollow?.();
      }
      // 就绪或已决：停止重试（已决卡片再拉毫无意义）
      if (this.isCardSettled(card)) {
        this.clearCardRetry(toolCallId);
        return;
      }
    }

    this.scheduleCardAttempt(bubbleId, toolCallId, toolName, attempt + 1);
  }

  /**
   * 卡片是否已无需再拉：权威 {@code status} 已到「可审批（pending）」或后续态（in_progress / completed）。
   *
   * <p><b>不能用 VO 的 {@code pending} 字段判就绪</b>：后端 {@code pending = isUnresolved()}（未终结即 true），
   * PREPARING 也返回 true —— 据此停查会把卡片永远钉死在首次拉到的「准备中」，用户拿不到审批按钮。
   * 只有显式 {@code status} 才分得清「准备中」与「等待审批」。</p>
   */
  private isCardSettled(card: ToolCallVO): boolean {
    const status = String(card.status ?? '').trim().toLowerCase();
    return status === 'pending' || status === 'in_progress' || status === 'completed';
  }

  /**
   * 安排一次有界重试。
   *
   * <p>未注入调度器时不做重试（保持「单次拉取」旧行为）。上限 {@link CARD_RETRY_MAX} 次、
   * 间隔 {@link CARD_RETRY_DELAY_MS} 毫秒 —— 这是安全网：兜住事件与落库之间的偶发可见性延迟，
   * 正常路径首批拉取即就绪。</p>
   */
  private scheduleCardAttempt(bubbleId: string, toolCallId: string, toolName: string | undefined, nextAttempt: number): void {
    if (this.disposed || !this.scheduleCardRetry) return;
    if (nextAttempt > CARD_RETRY_MAX) {
      console.warn('[TurnStreamReducer] 卡片就绪重试已达上限，放弃:', toolName ?? toolCallId);
      return;
    }
    const timerId = this.scheduleCardRetry(() => {
      this.cardRetryTimers.delete(toolCallId);
      void this.resolvePromptCard(bubbleId, toolCallId, toolName, nextAttempt);
    }, CARD_RETRY_DELAY_MS);
    this.cardRetryTimers.set(toolCallId, timerId);
  }

  /** 取消某个 toolCallId 的待重试定时器（就绪 / 已决后调用）。 */
  private clearCardRetry(toolCallId: string): void {
    const timerId = this.cardRetryTimers.get(toolCallId);
    if (timerId !== undefined) {
      this.cancelCardRetry?.(timerId);
      this.cardRetryTimers.delete(toolCallId);
    }
  }

  /** 取消全部待重试定时器（执行终结时调用）。 */
  private clearAllCardRetries(): void {
    for (const toolCallId of Array.from(this.cardRetryTimers.keys())) {
      this.clearCardRetry(toolCallId);
    }
  }

  /**
   * 释放：取消全部待重试的建卡定时器，之后不再接受新的重试。
   *
   * <p>组件卸载 / 会话切换时调用，避免回调写到已销毁的对象上。</p>
   */
  /** 释放：取消全部待重试的建卡定时器，之后不再接受新的重试。 */
  public dispose(): void {
    this.disposed = true;
    this.clearAllCardRetries();
    this.cardResolving.clear();
  }

  /**
   * 空实现，仅为兼容宿主（会话路由在切流 / 释放前统一调用）。
   *
   * <p>原始增量已不再进缓冲（内容全部来自块视图），因此没有「待刷新」的帧。</p>
   */
  public flush(): void {
    // no-op
  }
}

/**
 * 从 SSE 业务事件里取出块视图载荷。
 *
 * <p>后端把 {@code BlockEventPayload} 直接作为事件体下发（见 {@code SseEventPublisher#sendBusiness}
 * 的 {@code .data(payload)}），载荷字段平铺在事件 JSON 顶层。这里同时兼容「顶层平铺」（现行）
 * 与「包一层 payload」（防御未来信封化）两种形状；取不到返回 null，由调用方静默跳过。</p>
 */
function extractBlockPayload(raw: unknown): BlockEventPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const top = obj as unknown as BlockEventPayload;
  if (top.view && typeof top.view === 'object' && Array.isArray(top.view.blocks)) {
    return top;
  }
  const nested = obj.payload as BlockEventPayload | undefined;
  if (nested && nested.view && Array.isArray(nested.view.blocks)) {
    return nested;
  }
  return null;
}
