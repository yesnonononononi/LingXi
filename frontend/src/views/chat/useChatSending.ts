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

  /**
   * 本轮是否已被用户要求取消。
   *
   * <p><b>为什么取消要先变成「意图」而不是「一次请求」</b>：发送到首字之间，服务端可能
   * 还没有任何可取消对象（受理请求尚未到、或还在 prepare 阶段）。此刻发出去的那次 stop
   * 会空转，而随后到达的受理会把运行资格的 cancelled 标记清掉（`beginRoot` 的「新一轮重新开放受理」语义），
   * 于是这一次点击在系统里不留痕迹 —— 用户看到的就是「取消按钮没反应」。</p>
   *
   * <p>所以取消必须先在本地落成意图：受理尚未发出就地中止；已经发出则在受理回执到手后
   * <b>补发一次</b> —— 回执是在服务端登记（beginRoot + 执行行提交）之后才返回的，
   * 那一次 stop 必然命中已登记的执行，不会被吞。</p>
   */
  const cancelRequested = ref(false);

  /**
   * 受理请求是否已交给网络。
   *
   * <p>false = 还停在本地阶段（订阅就绪等待 / 图片预览 / 首次建会话），此时中止就是真取消：
   * 服务端零副作用，也不需要任何 stop 请求。</p>
   */
  let acceptDispatched = false;

  const sendFailureNotice = ref<{ sessionId: string; message: string } | null>(null);
  const dismissSendFailure = (): void => { sendFailureNotice.value = null; };

  /** 会话是否处于运行中：事件与对账共同驱动 runStatus，这里只做读取。 */
  const isSessionRunningNow = computed(
    () => isSessionRunning(currentActiveSession.value?.runStatus),
  );

  /** 界面消费的唯一「生成中」判据：受理在途 或 会话运行中。 */
  const isSending = computed(() => isSubmitting.value || isSessionRunningNow.value);

  /**
   * 发一次服务端停止请求。
   *
   * <p>不外抛：停止是「尽力而为 + 补偿重放」中的一环，失败由调用方决定是否提示，
   * 但绝不能让它变成未捕获的 rejection 或吃掉后续的补偿。</p>
   */
  const requestServerStop = async (sessionId: string | number): Promise<boolean> => {
    try {
      await AgentAPI.stop(sessionId);
      return true;
    } catch (error) {
      console.error('停止会话执行失败:', error);
      return false;
    }
  };

  const reportStopFailure = (sessionId: string): void => {
    sendFailureNotice.value = { sessionId, message: t('chat.controls.stopFailed') };
  };

  /** 撤销一条刚被排进待发送队列、且用户已经取消的命令；失败只留日志（队列会自行刷新对齐）。 */
  const cancelQueuedCommand = async (sessionId: string, pendingId: string): Promise<void> => {
    try {
      await AgentAPI.cancelPendingCommand(sessionId, pendingId);
    } catch (error) {
      console.error('撤销待发送命令失败:', error);
    }
  };

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
    cancelRequested.value = false;
    acceptDispatched = false;

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

      // 用户已在这段本地等待里取消：绝不把命令发出去。发出就有服务端副作用，
      // 再想撤就只能靠「停止」去追一条本不该存在的执行。
      if (controller.signal.aborted) return null;

      acceptDispatched = true;
      const result = await AgentAPI.acceptCommand(command, controller.signal);
      const data = result.data;
      if (!isOk(result.code) || !data?.sessionId) {
        throw new Error(result.errMsg || t('chat.view.sendFailed'));
      }
      if ('pendingId' in data && data.pendingId) {
        const queued = {sessionId: String(data.sessionId), pendingId: data.pendingId};
        if (cancelRequested.value) {
          // 排队中的那条就是用户取消的那条：直接撤销，别在「待发送」里留一条幽灵消息。
          await cancelQueuedCommand(queued.sessionId, queued.pendingId);
        }
        return queued;
      }
      if (!('turnId' in data) || !data.turnId) throw new Error(t('chat.view.sendFailed'));

      const acceptance = {
        sessionId: String(data.sessionId),
        turnId: String(data.turnId),
      };

      // ★ 补偿重放：回执到手 ⇒ 服务端已完成登记（beginRoot + 执行行提交）。
      // 用户若在这条命令「还没到服务端」时点过取消，那次 stop 在服务端是空转的
      // （无对象可取消，且随后的 beginRoot 会把停止意图清掉）。此刻补发一次，必然命中。
      if (cancelRequested.value) {
        const stopped = await requestServerStop(acceptance.sessionId);
        if (!stopped) reportStopFailure(acceptance.sessionId);
        // 不回写 RUNNING：本轮已被要求停止，界面不该闪一下「生成中」再变取消。
        scrollToBottom();
        return acceptance;
      }

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
      acceptDispatched = false;
      isSubmitting.value = false;
    }
  };

  /** 每次只提交一个请求，由后端决定立即受理还是入队。 */
  const handleSendMessage = async (command: ChatCommand): Promise<ChatCommandReceipt | null> => {
    if (isSubmitting.value) return null;
    if (!command.input.trim()) return null;
    return submitCommand(command);
  };

  /**
   * 停止生成（唯一入口）。
   *
   * <p>取消分两种，按「受理请求有没有发出去」判定，绝不再一律 abort：</p>
   * <ol>
   *   <li><b>还没发出去</b>：中止本地请求即可，服务端从未见过这条命令，没有执行需要取消。
   *       这里若顺手发一次 stop，只会给服务端塞一个没有对象的空意图。</li>
   *   <li><b>已经发出去</b>：立刻发一次（能停住已登记的执行最好），并置取消意图 ——
   *       受理回执到达时 {@link submitCommand} 会补发一次，那一次才是有保证的那次。</li>
   * </ol>
   *
   * <p>流不关（终态不关流是本模型的规定）。</p>
   */
  const handleStopGeneration = (): void => {
    cancelRequested.value = true;

    const controller = currentAbortController.value;
    if (controller && !acceptDispatched) {
      currentAbortController.value = null;
      controller.abort();
      return;
    }

    const sessionId = currentActiveSession.value?.id;
    if (sessionId && !isTempSessionId(sessionId)) {
      void requestServerStop(sessionId).then((stopped) => {
        if (!stopped) reportStopFailure(String(sessionId));
      });
    }
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
    cancelRequested,
    sendFailureNotice,
    dismissSendFailure,
    handleSendMessage,
    submitCommand,
    handleStopGeneration,
    abortInFlight,
  };
}
