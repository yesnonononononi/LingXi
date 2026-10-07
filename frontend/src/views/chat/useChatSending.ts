import { ref, computed, type ComputedRef } from 'vue';
import { AgentAPI, isAbortError } from '../../services/agent';
import type { ChatAcceptance, ChatSession } from '../../types/chat';
import { isTempSessionId, isPersistedSessionId } from '../../utils/ids';
import { isSessionRunning } from '../../utils/session';
import { isOk } from '../../utils/api';
import type { ChatCommand } from '../../services/dto/chat_command';

export interface ChatSendingOptions {
  /** 当前活动会话（用于停止生成时定位 sessionId）。 */
  currentActiveSession: ComputedRef<ChatSession | null | undefined>;

  /**
   * 确保该根会话已订阅且就绪（收到 READY）。
   *
   * <p>返回 false 表示没能就绪；调用方需重挂后重试，或显式报失败。</p>
   */
  ensureSubscribed: (sessionId: string) => Promise<boolean>;

  /** 显式重挂会话级流（就绪等待超时后的重试手段）。 */
  reconnectStream: () => void;

  /** 一轮结束后的历史对账：把服务端落库结果按分轮规则刷回会话实体。 */
  reconcileSessionAfterStream: (sessionId: string) => Promise<void> | void;

  /** 滚动到底部。 */
  scrollToBottom: () => void;

  /** 发送失败提示文案出口。 */
  onSendFailure?: (sessionId: string, message: string) => void;
}

/**
 * 发送链路。
 *
 * <p>「单一会话级流」形态：发送只做一次<b>同步受理</b>（POST {@code /a/completion/commands}），
 * 不带流、不读 SSE；实时正文全部来自会话级订阅。旧请求级流（{@code POST /a/completion/stream}）
 * 已随第三期删除。</p>
 *
 * <pre>
 * handleSendMessage
 *   → ensureSubscribed(sessionId)          （等 READY：已订阅且就绪）
 *   → AgentAPI.acceptCommand(command)      （POST multipart，同步受理，返回权威 sessionId/turnId）
 *   → runStatus = 'RUNNING'                （事件驱动为唯一真源，POST 返回即视为已受理）
 * </pre>
 *
 * <p><b>为什么 isSending 不能只看 POST 在途</b>：受理是同步的，POST 立刻返回，
 * 而模型调用仍在跑。若把「生成中」绑定在 POST 上，返回瞬间界面就会显示可再次发送 ——
 * 后端会以「该会话正在执行中」拒绝，用户连点两次只看到报错。
 * 故 {@code isSending = isSubmitting || 会话处于运行中}。</p>
 */
export function useChatSending(options: ChatSendingOptions) {
  const {
    currentActiveSession,
    ensureSubscribed,
    reconnectStream,
    reconcileSessionAfterStream,
    scrollToBottom,
    onSendFailure,
  } = options;

  /**
   * 受理 POST 是否在途。
   *
   * <p>它是「POST 尚未返回时禁止重复点击」的唯一依据：不能只等 EXECUTION_STARTED 才禁用发送，
   * 否则受理窗口内的连点会重复提交。</p>
   */
  const isSubmitting = ref(false);
  const currentAbortController = ref<AbortController | null>(null);

  const sendFailureNotice = ref<{ sessionId: string; message: string } | null>(null);
  const dismissSendFailure = (): void => { sendFailureNotice.value = null; };

  /** 会话是否处于运行中：事件与对账共同驱动 runStatus，这里只做读取。 */
  const isSessionRunningNow = computed(
    () => isSessionRunning(currentActiveSession.value?.runStatus),
  );

  /** 界面消费的唯一「生成中」判据：受理在途 或 会话运行中。 */
  const isSending = computed(() => isSubmitting.value || isSessionRunningNow.value);

  /**
   * 受理一次聊天请求（同步落库，异步执行）。
   *
   * <p>返回权威 {@code sessionId} / {@code turnId}；受理被拒时返回 null 并给出可见失败提示。</p>
   */
  const submitCommand = async (command: ChatCommand): Promise<ChatAcceptance | null> => {
    if (!command.input.trim()) return null;

    const sessionId = command.sessionId != null ? String(command.sessionId) : '';
    const controller = new AbortController();
    currentAbortController.value = controller;
    isSubmitting.value = true;

    try {
      // 先确保已订阅且就绪：受理与事件投递之间没有先后保证，未就绪就提交会丢首帧。
      let ready = await ensureSubscribed(sessionId);
      if (!ready) {
        reconnectStream();
        ready = await ensureSubscribed(sessionId);
      }
      if (!ready) {
        throw new Error('实时通道未就绪，请稍后重试');
      }

      const result = await AgentAPI.acceptCommand(command, controller.signal);
      if (!isOk(result.code) || !result.data?.sessionId || !result.data?.turnId) {
        throw new Error(result.errMsg || '发送失败');
      }

      const acceptance: ChatAcceptance = {
        sessionId: String(result.data.sessionId),
        turnId: String(result.data.turnId),
      };
      // 受理已落库：会话进入运行中。后续事件与终态都会继续纠正它。
      const session = currentActiveSession.value;
      if (session && String(session.id) === acceptance.sessionId) {
        session.runStatus = 'RUNNING';
      }
      scrollToBottom();
      return acceptance;
    } catch (error) {
      // 用户点「停止生成」导致的 abort 是预期行为，不弹提示。
      if (isAbortError(error)) return null;

      const message = error instanceof Error ? error.message : '发送失败';
      sendFailureNotice.value = { sessionId, message };
      onSendFailure?.(sessionId, message);
      // 受理被拒（例如会话还有挂起执行）时，本地乐观写下的 RUNNING 必须按权威状态纠正，
      // 否则界面永远显示「生成中」，且会话级流的开关条件不再成立。
      if (isPersistedSessionId(sessionId)) {
        await reconcileSessionAfterStream(sessionId);
      }
      return null;
    } finally {
      // 只有仍是「当前这轮」时才清空，避免后到的请求覆盖新请求的控制器。
      if (currentAbortController.value === controller) {
        currentAbortController.value = null;
      }
      isSubmitting.value = false;
    }
  };

  /** 发送新消息（同步受理）。 */
  const handleSendMessage = async (command: ChatCommand): Promise<ChatAcceptance | null> => {
    // 受理窗口内禁止重复提交；运行中同样禁止（后端会以「会话正在执行中」拒绝）。
    if (isSending.value) return null;
    if (!command.input.trim()) return null;
    return submitCommand(command);
  };

  /** 停止生成：让服务端终止执行。流不关（终态不关流是本模型的规定）。 */
  const handleStopGeneration = (): void => {
    const sessionId = currentActiveSession.value?.id;
    if (sessionId && !isTempSessionId(sessionId)) {
      void AgentAPI.stop(sessionId).catch((error) => {
        console.error('停止会话执行失败:', error);
      });
    }
    currentAbortController.value?.abort();
    currentAbortController.value = null;
  };

  /** 中断在途受理请求（切走会话 / 组件卸载）。 */
  const abortInFlight = (): void => {
    currentAbortController.value?.abort();
    currentAbortController.value = null;
  };

  return {
    isSubmitting,
    isSending,
    currentAbortController,
    sendFailureNotice,
    dismissSendFailure,
    handleSendMessage,
    submitCommand,
    handleStopGeneration,
    abortInFlight,
  };
}