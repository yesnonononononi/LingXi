import {computed, type ComputedRef, ref} from 'vue';
import {AgentAPI, isAbortError} from '../../services/agent';
import type {ChatCommandReceipt, ChatSession} from '../../types/chat';
import {isPersistedSessionId, isTempSessionId} from '../../utils/ids';
import {isSessionRunning} from '../../utils/session';
import {isOk} from '../../utils/api';
import type {ChatCommand} from '../../services/dto/chat_command';
import {t} from '../../i18n';
import {useUserConfigStore} from '../../stores/userConfigStore';

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

/** 会话级流负责正文，发送回执只区分已落库的轮次与待发送消息。 */
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

  /** 待发送回执不能改变当前轮次的运行状态。 */
  const submitCommand = async (command: ChatCommand): Promise<ChatCommandReceipt | null> => {
    if (!command.input.trim()) return null;

    const sessionId = command.sessionId != null ? String(command.sessionId) : '';

    // 数据目录已改但本进程还没重启：本轮的库文件仍写在旧目录，重启后新目录里没有这一段。
    // 必须拦住并说明原因 —— 让消息发出去再丢失，比当场发不出去糟糕得多。
    if (useUserConfigStore().dataDirRestartRequired) {
      const message = t('chat.view.dataDirRestartRequired');
      sendFailureNotice.value = { sessionId, message };
      onSendFailure?.(sessionId, message);
      return null;
    }

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
        throw new Error(t('chat.view.channelNotReady'));
      }

      const result = await AgentAPI.acceptCommand(command, controller.signal);
      const data = result.data;
      if (!isOk(result.code) || !data?.sessionId) {
        throw new Error(result.errMsg || t('chat.view.sendFailed'));
      }
      if ('pendingId' in data && data.pendingId) {
        return {sessionId: String(data.sessionId), pendingId: data.pendingId};
      }
      if (!('turnId' in data) || !data.turnId) throw new Error(t('chat.view.sendFailed'));

      const acceptance = {
        sessionId: String(data.sessionId),
        turnId: String(data.turnId),
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

      const message = error instanceof Error ? error.message : t('chat.view.sendFailed');
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

  /** 每次只提交一个请求，由后端决定立即受理还是入队。 */
  const handleSendMessage = async (command: ChatCommand): Promise<ChatCommandReceipt | null> => {
    if (isSubmitting.value) return null;
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
