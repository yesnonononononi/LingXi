import type { AgentEvent, TokenInfo } from '../../types/Event';
import type { BlockEventPayload } from '../../types/block';
import type { ChatMessage, ContextUsageData, ToolCallTrace, ToolCallVO } from '../../types/chat';
import { AgentToolName } from '../../utils/toolNames';
import { resolveToolCategory, resolveToolExecutionStatus, isEditFileTool, extractSubAgentParams } from '../../utils/toolMeta';
import { isCardToolName, upsertPromptCard } from '../../utils/toolCallCard';
import { toObject } from '../../utils/json';
import { parseToolDiff } from '../../utils/toolDiff';
import { StreamFrameBuffer } from './streamFrameBuffer';
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
 * <p>将底层离散的运行时事件汇聚为单一 Assistant 回答气泡。
 * 忽略网络分包、心跳与重复广播噪声，维护深度思考、时序工具调用与增量正文。</p>
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
  private frameBuffer: StreamFrameBuffer;
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

    this.frameBuffer = new StreamFrameBuffer((textBatch, thinkBatch) => {
      let hasChanges = false;

      textBatch.forEach((chunk, bubbleId) => {
        const bubble = this.findMessageById(bubbleId);
        if (bubble) {
          bubble.content = (bubble.content || '') + chunk;
          hasChanges = true;
        }
      });

      thinkBatch.forEach((chunk, bubbleId) => {
        const bubble = this.findMessageById(bubbleId);
        if (bubble && bubble.thoughtSteps && bubble.thoughtSteps.length > 0) {
          const step = bubble.thoughtSteps[bubble.thoughtSteps.length - 1];
          step.content = (step.content || '') + chunk;
          hasChanges = true;
        }
      });

      if (hasChanges) {
        this.onScrollFollow?.();
      }
    });
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

      case 'PARTIAL_THINKING':
        this.handlePartialThinking(event.content);
        break;

      case 'PARTIAL_TEXT':
        this.handlePartialText(event.content);
        break;

      case 'COMPLETE_TEXT':
        this.handleCompleteText(event.content);
        break;

      case 'TOOL_CALL':
        this.handleToolCall(event);
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

      case 'AI_MESSAGE':
        // 传输层全量备份，流式渲染直接作为噪声丢弃
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
    if (last !== undefined && payload.viewVersion < last) {
      // 乱序到达的旧帧：丢弃，绝不用旧内容覆盖新内容。
      return;
    }
    this.turnViewVersions.set(turnId, payload.viewVersion);

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
      thoughtSteps: [],
      toolCalls: [],
      // 中间叙述必须从一开始就存在：实时路径原先只写 content，导致流式期间所有轮次的
      // 文本都堆在正文里、对账后才被搬进过程区（用户看到一次跳变）。见 handleToolCall。
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

  private handlePartialThinking(chunk: string): void {
    if (!chunk) return;
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isThinking = true;
    bubble.isSuspended = false;

    // 思考按「与工具调用同粒度」分段：上一段已被工具 / 中间正文边界收尾（status 非 running）时开启新步，
    // 而不是把整轮思考都追加进同一个步骤（那样整轮思考会挤成一个「深度思考」大框）。
    const steps = bubble.thoughtSteps ?? (bubble.thoughtSteps = []);
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
    if (!lastStep || lastStep.status !== 'running') {
      steps.push({
        id: `step-${bubble.id}-${steps.length}`,
        title: '深度思考',
        content: '',
        status: 'running',
        order: this.allocateOrder(bubble)
      });
    }

    this.frameBuffer.pushThinking(bubble.id, chunk);
  }

  private handlePartialText(chunk: string): void {
    if (!chunk) return;
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isExploring = false;
    bubble.isSuspended = false;
    // 又吐出新正文 = 这一轮重新进入生成态。上一条工具收尾时推断出的「已终结」必须撤回，
    // 否则气泡会带着 isComplete=true 继续流式，watch(false→true) 的收起动画不会触发，
    // 对账也会误以为「本地已完结」而拒绝用权威历史替换该轮。
    bubble.isComplete = false;

    if (bubble.thoughtSteps) {
      bubble.thoughtSteps.forEach(step => {
        if (step.status === 'running') {
          step.status = 'success';
        }
      });
    }

    this.frameBuffer.pushText(bubble.id, chunk);
  }

  private handleCompleteText(fullContent: string): void {
    this.frameBuffer.flushImmediate();
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    if (fullContent) {
      bubble.content = fullContent;
    }
    bubble.isThinking = false;
    bubble.isExploring = false;
    bubble.isSuspended = false;

    if (bubble.thoughtSteps) {
      bubble.thoughtSteps.forEach(step => {
        if (step.status === 'running') {
          step.status = 'success';
        }
      });
    }

    this.onScrollFollow?.();
  }

  private handleToolCall(event: { requestId?: string; toolName?: string; args?: string }): void {
    this.frameBuffer.flushImmediate();
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isExploring = false;
    bubble.isSuspended = false;

    if (bubble.thoughtSteps) {
      bubble.thoughtSteps.forEach(step => {
        if (step.status === 'running') step.status = 'success';
      });
    }

    // 工具调用意味着「本轮叙述到此为止」：把已累计的文本从正文移到中间叙述集合。
    // 判据与历史路径一致（aggregateSessionMessages：同一轮里文本行后跟工具行 = 中间过程），
    // 因此对账替换时 intermediateAiMessages 的「等于正文则剔除」判据继续成立、不再跳变。
    // 放在 requestId 守卫之前：缺 requestId 只是不建卡，工具调用本身已经发生，正文同样该断句。
    if (bubble.content && bubble.content.trim()) {
      if (!bubble.aiMessages) {
        bubble.aiMessages = [];
      }
      bubble.aiMessages.push({
        id: `ai-${bubble.id}-${bubble.aiMessages.length}`,
        text: bubble.content,
        order: this.allocateOrder(bubble)
      });
      bubble.content = '';
    }

    // requestId 是后端 tool_call 主键，缺失则不建卡：伪造 ID 会让同一次调用的开始/结束事件落到两个气泡上。
    // 不用 `as string` 绕过 —— types/chat.ts 的 id: string 是编译期约束，让 vue-tsc 报错才是保护。
    const requestId = event.requestId;
    if (!requestId) {
      console.warn('[stream] TOOL_CALL 缺 requestId，该工具调用不建卡: toolName=%s', event.toolName);
      return;
    }
    if (!bubble.toolCalls) {
      bubble.toolCalls = [];
    }

    const existingTool = bubble.toolCalls.find(tc => tc.id === requestId);
    if (!existingTool) {
      // toolName 同样不兜底：TOOL_CALL 只在框架 invokeTool 内发布（工具已注册且通过审批），
      // 恒非空。编个 ExecuteCommand 会渲染成「执行命令」卡片，把工具报错伪装成命令执行。
      const toolName = event.toolName;
      if (!toolName) {
        console.warn('[stream] TOOL_CALL 缺 toolName，该工具调用不建卡: id=%s', requestId);
        return;
      }
      const rawArgs = event.args || '';
      const parsedArgs = toObject(rawArgs, {});
      const toolCategory = resolveToolCategory(toolName);

      const toolTrace: ToolCallTrace = {
        id: requestId,
        toolName,
        category: toolCategory,
        query: rawArgs,
        args: parsedArgs,
        status: 'calling',
        order: this.allocateOrder(bubble)
      };

      if (toolName === AgentToolName.CallSubAgent) {
        const subParams = extractSubAgentParams({ query: rawArgs, subSessionId: parsedArgs.subSessionId });
        toolTrace.subAgentId = parsedArgs.agentId ?? subParams.agentId;
        toolTrace.subAgentName = parsedArgs.agentName ?? subParams.agentName;
        toolTrace.subTask = parsedArgs.task ?? subParams.task;
        toolTrace.subPrompt = parsedArgs.prompt ?? subParams.prompt;
        toolTrace.subSessionId = parsedArgs.subSessionId ?? subParams.subSessionId;
      }

      bubble.toolCalls.push(toolTrace);

      // PROMISE 类工具（计划 / 提问 / 命令审批）：拉权威 ToolCallVO 建卡。
      // 查不到 / 查失败都不建卡、不伪造状态；此刻后端行可能尚未落库或仍是 PREPARING，
      // 由 requestPromptCard 的就绪重试（安全网）继续拉直到 pending。
      if (isCardToolName(toolName)) {
        this.requestPromptCard(bubble.id, requestId);
      }
    }

    this.onScrollFollow?.();
  }

  private handleToolCompleted(event: {
    requestId?: string;
    toolName?: string;
    output?: string;
    resultStatus?: string;
  }): void {
    this.frameBuffer.flushImmediate();
    const bubble = this.obtainActiveBubble(this.currentTurnId);

    // 终端审批（命令审批）在 policy 内短路，框架只发 TOOL_COMPLETED(resultStatus=PROMISED)、
    // 从不发 TOOL_CALL，因此下方按已有轨迹找不到目标、也建不出卡片。必须用完成事件自带的权威
    // 调用 ID 直接拉卡，否则实时审批卡要等到刷新后从历史聚合才出现。
    // requestId 缺失同样不建卡：伪造 ID 会让卡片挂到错误的调用上。
    if (event.resultStatus === 'PROMISED' && event.requestId) {
      this.requestPromptCard(bubble.id, event.requestId);
    }

    if (!bubble.toolCalls) return;

    const requestId = event.requestId;
    const target = bubble.toolCalls.find(tc => tc.id === requestId);
    if (target) {
      const outputText = event.output || '';
      target.result = outputText;
      target.status = resolveToolExecutionStatus(event.resultStatus);

      if (isEditFileTool(target.toolName)) {
        const diffStat = parseToolDiff({
          toolName: target.toolName,
          result: outputText
        });
        if (diffStat) {
          target.plusLines = diffStat.plusLines ?? undefined;
          target.minusLines = diffStat.minusLines ?? undefined;
        }
      }
    }

    // 工具结果已写回：若该轮全部工具都已收尾，则这一轮事实上已终结（见 markCompleteIfToolsSettled）
    this.markCompleteIfToolsSettled(bubble);

    this.onScrollFollow?.();
  }

  /**
   * 由实时事实推断「本轮已终结」的唯一一处。
   *
   * <p>执行结束后气泡只有一个终结信号（EXECUTION_COMPLETED / FAILED / CANCELLED）。若终结事件
   * 在建立订阅之前就已发生（进入会话晚于执行结束），气泡会永远停在 {@code isComplete: false}，
   * 使对账把它当成「进行中的本地气泡」而拒绝用权威历史替换 / 补齐该轮过程数据
   * （表现为「工具调用永远显示运行中、工具条不出现」）。</p>
   *
   * <p><b>判据只能是「工具已有结果」——不得用 {@code isThinking}/{@code isExploring} 推断</b>：
   * 中间叙述帧会把这两者都置为 false（`handlePartialText`），模型往往还要接着调工具，
   * 据此判终结会把仍在进行的一轮提前钉成完成态。工具结果只在 {@link handleToolCompleted}
   * 写入，因此判据自包含：**所有已知工具调用都有终态结果，且没有正在流式的思考或正文**。</p>
   *
   * <p>终结后照常返回，事件流若仍在继续，后续过程项照旧能被 push 进来 —— 这里只是让对账
   * 不再把它当「进行中」，不是冻结气泡。</p>
   */
  private markCompleteIfToolsSettled(bubble: ChatMessage): void {
    const toolCalls = bubble.toolCalls;
    if (!toolCalls || toolCalls.length === 0) return;
    if (!toolCalls.every(call => typeof call.result === 'string')) return;
    if (this.frameBuffer.hasPending(bubble.id)) return;

    bubble.isComplete = true;
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
    this.frameBuffer.flushImmediate();
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isThinking = false;
    bubble.isExploring = false;
    bubble.isSuspended = true;

    // 挂起是思考段的边界：收尾当前思考步，避免留下永不结束的 running 步
    if (bubble.thoughtSteps) {
      bubble.thoughtSteps.forEach(step => {
        if (step.status === 'running') step.status = 'success';
      });
    }

    // 将进行中的工具调用标记为 pending 待审批状态；PROMISE 类再拉一次权威卡片兜底
    if (bubble.toolCalls) {
      bubble.toolCalls.forEach(tc => {
        if (tc.status === 'calling') {
          tc.status = 'pending';
        }
      });
      bubble.toolCalls.forEach(tc => {
        if (tc.status === 'pending' && isCardToolName(tc.toolName)) {
          this.requestPromptCard(bubble.id, tc.id);
        }
      });
    }

    this.onScrollFollow?.();
  }

  private handleExecutionResumed(): void {
    this.frameBuffer.flushImmediate();
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isSuspended = false;
    bubble.isThinking = true;

    if (bubble.toolCalls) {
      bubble.toolCalls.forEach(tc => {
        if (tc.status === 'pending') {
          tc.status = 'calling';
        }
      });
    }

    this.onScrollFollow?.();
  }

  private handleExecutionCompleted(tokenInfo: TokenInfo | null): void {
    this.frameBuffer.flushImmediate();
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isComplete = true;
    bubble.isThinking = false;
    bubble.isExploring = false;
    bubble.isSuspended = false;
    bubble.tokenInfo = tokenInfo ?? undefined;

    // 执行终结：卡片不会再有就绪机会，取消全部待重试定时器
    this.clearAllCardRetries();

    if (bubble.thoughtSteps) {
      bubble.thoughtSteps.forEach(step => {
        if (step.status === 'running') step.status = 'success';
      });
    }

    if (bubble.toolCalls) {
      bubble.toolCalls.forEach(tc => {
        if (tc.status === 'calling') {
          // 轮次终结时仍在 calling = 工具结果事件没到。只改状态不编造 result 文案，
          // 且必须留痕：否则「工具没跑完」与「工具跑了但结果没落库」在界面上无法区分。
          console.warn('[stream] 轮次终结时工具仍为 calling，置为 unknown: toolName=%s, id=%s', tc.toolName, tc.id);
          tc.status = 'unknown';
        }
      });
    }

    this.activeBubbleId = null;
    this.onScrollFollow?.();
  }

  private handleExecutionFailed(errMsg?: string): void {
    this.frameBuffer.flushImmediate();
    const bubble = this.obtainActiveBubble(this.currentTurnId);
    bubble.isComplete = true;
    bubble.isThinking = false;
    bubble.isExploring = false;
    bubble.isSuspended = false;
    // 执行终结：卡片不会再有就绪机会，取消全部待重试定时器
    this.clearAllCardRetries();
    // 失败原因写进 content（正文尾部），不能只写 sendError —— 该字段全仓 0 读取点，写进去等于丢弃。
    // 与历史路径同形：刷新后从 turn.errorReason 看到，实时阶段从本段正文看到，两处口径一致。
    if (errMsg) {
      bubble.content = bubble.content ? `${bubble.content}\n\n${errMsg}` : errMsg;
    }

    if (bubble.thoughtSteps) {
      bubble.thoughtSteps.forEach(step => {
        if (step.status === 'running') step.status = 'failed';
      });
    }

    this.activeBubbleId = null;
    this.onScrollFollow?.();
  }

  private handleExecutionCancelled(): void {
    this.frameBuffer.flushImmediate();
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
   * 分配时间线顺序：实时新增的思考步、中间文本与工具调用统一取「当前时间线最大 order + 1」。
   *
   * <p><b>必须继承已有最大值，不能按项数重新计数</b>：气泡可能来自历史聚合
   * （order 基准是原始行下标 × {@code TIMELINE_SLOT_STRIDE}），也可能由对账合并而来。
   * 按项数从 0 重新编号会给新项一个远小于历史 order 的值，渲染层升序排序后
   * 新思考会插进旧工具中间（用户看到「续写的思考跑到旧过程里」）。</p>
   *
   * <p>取「最大值 + 1」而非「最大值 + 步长」：相对顺序才是渲染层的唯一依据，
   * 连续编号已足够表达先后，也不必关心历史是否用同一套步长。</p>
   *
   * <p><b>四类必须全部计入</b>：漏掉任何一类都会让新项与旧项拿到相同 / 更小的 order
   * （aiMessages 尤其易漏），排序退化成依赖插入顺序，表现为过程项偶发错位。</p>
   *
   * <p>必须在 push 新项之前调用。</p>
   */
  private allocateOrder(bubble: ChatMessage): number {
    let maxOrder = -1;
    const consider = (order?: number): void => {
      if (typeof order === 'number' && order > maxOrder) maxOrder = order;
    };
    (bubble.thoughtSteps ?? []).forEach(step => consider(step.order));
    (bubble.toolCalls ?? []).forEach(call => consider(call.order));
    (bubble.aiMessages ?? []).forEach(message => consider(message.order));
    // promptCards 是 ToolCallVO，契约上没有 order（它是卡片不是时间线项）；这里按可选读取，
    // 读不到就是 undefined，不参与比较 —— 不要为了「凑齐四类」而给它造一个字段。
    (bubble.promptCards ?? []).forEach(card => consider((card as { order?: number }).order));
    (bubble.processTimeline ?? []).forEach(item => consider(item.order));
    return maxOrder + 1;
  }

  /**
   * 请求一次「卡片就绪」拉取（并发/重复触发按 toolCallId 去重，避免定时器叠加）。
   */
  private requestPromptCard(bubbleId: string, toolCallId: string): void {
    if (this.disposed || !toolCallId) return;
    if (this.cardResolving.has(toolCallId) || this.cardRetryTimers.has(toolCallId)) return;
    void this.resolvePromptCard(bubbleId, toolCallId, 0);
  }

  /**
   * 拉取权威卡片并挂到气泡上（幂等：按 id 覆盖）。
   *
   * <p>「查不到」「查失败」都**不建卡、不伪造状态**，并纳入有界重试；只有 `type==='PROMISE'`
   * 才建卡。就绪（权威 `pending=true`）或已决（`completed`/`in_progress`）即停止重试。</p>
   *
   * <p>气泡按 id 现查而非持引用：会话对账会整体替换 messages，持有旧引用会写到脱离渲染的对象上。</p>
   */
  private async resolvePromptCard(bubbleId: string, toolCallId: string, attempt: number): Promise<void> {
    if (this.disposed || !this.onResolveCard || !toolCallId) return;
    if (this.cardResolving.has(toolCallId)) return;
    this.cardResolving.add(toolCallId);

    let card: ToolCallVO | null = null;
    try {
      card = await this.onResolveCard(toolCallId);
    } catch (err) {
      // 查失败同样不建卡；纳入重试（网络抖动不该让卡片永远停在「准备中」）
      console.warn('[TurnStreamReducer] 拉取互动卡片失败，稍后重试（不伪造状态）:', toolCallId, err);
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

    this.scheduleCardAttempt(bubbleId, toolCallId, attempt + 1);
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
  private scheduleCardAttempt(bubbleId: string, toolCallId: string, nextAttempt: number): void {
    if (this.disposed || !this.scheduleCardRetry) return;
    if (nextAttempt > CARD_RETRY_MAX) {
      console.warn('[TurnStreamReducer] 卡片就绪重试已达上限，放弃:', toolCallId);
      return;
    }
    const timerId = this.scheduleCardRetry(() => {
      this.cardRetryTimers.delete(toolCallId);
      void this.resolvePromptCard(bubbleId, toolCallId, nextAttempt);
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
  public dispose(): void {
    this.disposed = true;
    this.clearAllCardRetries();
    this.cardResolving.clear();
  }

  /** 强制同步所有缓冲内容 */
  public flush(): void {
    this.frameBuffer.flushImmediate();
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
