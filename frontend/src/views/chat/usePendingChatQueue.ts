import {ref, shallowRef, watch, type Ref} from 'vue';
import {t} from '../../i18n';
import {AgentAPI} from '../../services/agent';
import type {PendingTaskEntry, PendingTaskSnapshot, PendingTaskUpdate} from '../../types/chat';
import type {Result} from '../../services/types';
import {isOk} from '../../utils/api';

/**
 * 空面板 5s、有内容或会话在跑 1s。
 *
 * <p>面板多半时候是空的，1s 一次等于白刷；而一旦有排队消息或正在执行，
 * 用户就盯着它看，5s 的延迟会让人觉得「卡住了」。</p>
 */
const IDLE_INTERVAL_MS = 5000;
const ACTIVE_INTERVAL_MS = 1000;

/** 回填用：附件 id 与它读出来的 `File` 一一对应（见 `attachmentFiles`）。 */
export interface PendingAttachmentFile {
  id: string;
  file: File;
}

export function usePendingChatQueue(sessionId: Readonly<Ref<string | null>>, isActive: () => boolean) {
  const snapshot = shallowRef<PendingTaskSnapshot | null>(null);
  const error = ref('');
  const changing = ref(false);
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stopPolling() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 有没有值得高频盯着的东西：队列非空，或当前会话正在执行。 */
  function isBusy(): boolean {
    return (snapshot.value?.entries.length ?? 0) > 0 || isActive();
  }

  async function refresh(owner = sessionId.value) {
    if (!owner || owner !== sessionId.value) return;
    const request = ++revision;
    try {
      const result = await AgentAPI.pendingCommands(owner);
      if (request !== revision || owner !== sessionId.value) return;
      if (isOk(result.code) && Array.isArray(result.data?.entries)) snapshot.value = result.data;
    } catch (cause) {
      if (request === revision && owner === sessionId.value) console.warn('读取待发送队列失败:', cause);
    }
  }

  /**
   * 递归 setTimeout 而不是 setInterval。
   *
   * <p>间隔要跟着状态走（空 5s / 忙 1s）；用 setInterval 就得在每次状态变化时清掉重建，
   * 而且上一轮请求还没回来时会叠加请求。递归版天然串行，间隔在每轮结束时按当下状态算。</p>
   */
  function schedule(owner: string) {
    stopPolling();
    timer = setTimeout(async () => {
      timer = null;
      if (sessionId.value !== owner) return;
      if (!changing.value) await refresh(owner);
      if (sessionId.value === owner) schedule(owner);
    }, isBusy() ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
  }

  watch(sessionId, (owner, _previous, onCleanup) => {
    snapshot.value = null;
    error.value = '';
    if (!owner) {
      stopPolling();
      return;
    }
    void refresh(owner);
    schedule(owner);
    onCleanup(() => {
      revision++;
      stopPolling();
    });
  }, {immediate: true});

  async function change(action: (owner: string) => Promise<Result<void>>): Promise<boolean> {
    const owner = sessionId.value;
    if (!owner || changing.value) return false;
    changing.value = true;
    error.value = '';
    let ok = false;
    try {
      const result = await action(owner);
      if (!isOk(result.code)) throw new Error(result.errMsg || t('chat.pending.operationFailed'));
      ok = true;
    } catch (cause) {
      if (owner === sessionId.value) {
        error.value = cause instanceof Error ? cause.message : t('chat.pending.operationFailed');
      }
    } finally {
      await refresh(owner);
      if (owner === sessionId.value) schedule(owner);
      changing.value = false;
    }
    return ok;
  }

  /** 缩略图地址：图片字节按需加载，绝不进快照。 */
  function attachmentUrl(pendingId: string, attachmentId: string): string {
    return sessionId.value
      ? AgentAPI.pendingAttachmentUrl(sessionId.value, pendingId, attachmentId)
      : '';
  }

  /**
   * 把一条排队消息的图片读成 {@link File}，供「回填编辑」回填附件。
   *
   * <p>返回 **id 与 File 的配对**而不是裸数组：调用方要用「同一个 File 对象还在不在」
   * 判断用户保留了哪几张，配对一旦丢了就只能按文件名猜，同名图会串。</p>
   *
   * <p>调用方必须在 cancel **之前**调用：撤销会把磁盘上的附件一起删掉，
   * 顺序反了就只能回填出文字，用户得重新挑图。</p>
   */
  async function attachmentFiles(entry: PendingTaskEntry): Promise<PendingAttachmentFile[]> {
    const owner = sessionId.value;
    if (!owner || entry.attachments.length === 0) return [];
    const restored: PendingAttachmentFile[] = [];
    for (const attachment of entry.attachments) {
      try {
        const response = await fetch(AgentAPI.pendingAttachmentUrl(owner, entry.id, attachment.id));
        if (!response.ok) continue;
        const blob = await response.blob();
        restored.push({
          id: attachment.id,
          file: new File([blob], attachment.name, {type: blob.type || 'image/png'}),
        });
      } catch (cause) {
        console.warn('读取待发送图片失败:', cause);
      }
    }
    return restored;
  }

  return {
    snapshot, error, changing, refresh, attachmentUrl, attachmentFiles,
    cancel: (id: string) => change(owner => AgentAPI.cancelPendingCommand(owner, id)),
    confirm: (id: string) => change(owner => AgentAPI.confirmPendingCommand(owner, id)),
    /**
     * 原位修改：只改这一条，不撤销、也不重新上传被保留的图。
     *
     * <p>`keepAttachmentIds` 传 `undefined` 表示「附件不动」；传数组表示只留列出的那些。</p>
     */
    update: (id: string, request: PendingTaskUpdate) =>
      change(owner => AgentAPI.updatePendingCommand(owner, id, request)),
    resume: () => change(owner => AgentAPI.resumePendingCommands(owner)),
  };
}
