/**
 * 自动更新的渲染层状态管理。
 *
 * 职责边界（刻意收紧）：
 *   - 只消费主进程下发的状态、只发「检查/下载/安装」三种意图
 *   - 不做任何 URL 拼接、不做校验、不碰文件系统
 *   所有安全判定都在主进程，这里拿到什么就显示什么 —— 即便这里被注入，
 *   攻击者也只能点一个已经被主进程验签确认过的按钮。
 *
 * ⚠️ forceupdate 的来源必须只有一处：主进程验签后的 payload.forceupdate。
 *    不要在这里「顺便」解析 releaseNotes 里的声明块来判强制更新 ——
 *    正文未受签名保护（见 update.ts 的 extractUpdateClaimForDisplay 注释）。
 */

import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import type { UpdateState, UpdateStatePayload } from '../types/update';
import { describeUpdateState, stripUpdateClaim } from '../types/update';

export function useAppUpdater() {
  const state = ref<UpdateState>('idle');
  const currentVersion = ref('');
  const availableVersion = ref('');
  const releaseNotes = ref('');
  const forceupdate = ref(false);
  const mandatory = ref(false);
  const installable = ref(true);
  const rejectReason = ref<string | null>(null);
  const percent = ref(0);
  const bytesPerSecond = ref(0);
  const errorMessage = ref('');
  const /** 是否已订阅（避免重复注册） */ subscribed = ref(false);

  /** 是否处于 Electron 桌面端且更新接口可用 */
  const supported =
    typeof window !== 'undefined' && typeof window.electronAPI?.updater?.getState === 'function';

  let unsubscribe: (() => void) | null = null;

  function apply(payload: UpdateStatePayload) {
    state.value = payload.state;
    if (payload.currentVersion) currentVersion.value = payload.currentVersion;
    // 只有当前阶段确实带 pending 信息时才覆盖版本号，避免「not-available」把上一条清掉后又被冲回
    availableVersion.value = payload.availableVersion ?? '';
    releaseNotes.value = stripUpdateClaim(payload.releaseNotes);
    // 只有主进程的验签结论才作数
    forceupdate.value = payload.forceupdate === true;
    mandatory.value = payload.mandatory === true;
    installable.value = payload.installable !== false;
    rejectReason.value = payload.rejectReason ?? null;
    percent.value = typeof payload.percent === 'number' ? payload.percent : 0;
    bytesPerSecond.value = payload.bytesPerSecond ?? 0;
    errorMessage.value = payload.error ?? '';
  }

  /**
   * 拉取初值并**按阶段还原**界面。
   *
   * ⚠️ 不能用「有 pending 就置 available」：那会把后台已下载完成的显示成待下载、
   *    把下载中的进度条抹掉、把出错状态隐藏成正常。阶段以主进程的 phase 为准。
   */
  async function refresh() {
    if (!supported) return;
    const initial = await window.electronAPI!.updater!.getState();
    if (!initial) return;
    currentVersion.value = initial.currentVersion;
    if (!initial.enabled) {
      state.value = 'disabled';
      return;
    }

    state.value = initial.phase;
    errorMessage.value = initial.error ?? '';
    percent.value = initial.progress?.percent ?? 0;
    bytesPerSecond.value = initial.progress?.bytesPerSecond ?? 0;

    if (initial.pending) {
      availableVersion.value = initial.pending.version;
      releaseNotes.value = stripUpdateClaim(initial.pending.releaseNotes);
      forceupdate.value = initial.pending.forceupdate;
      mandatory.value = initial.pending.mandatory === true;
      installable.value = initial.pending.installable;
      rejectReason.value = initial.pending.rejectReason;
    } else {
      availableVersion.value = '';
      releaseNotes.value = '';
      forceupdate.value = false;
      mandatory.value = false;
      rejectReason.value = null;
    }
  }

  /** 手动检查更新。返回是否成功发起（不代表「有更新」） */
  async function check(): Promise<boolean> {
    if (!supported) return false;
    const r = await window.electronAPI!.updater!.check();
    if (!r.ok && r.error) {
      errorMessage.value = r.error;
      state.value = 'error';
    }
    return r.ok;
  }

  async function download(): Promise<boolean> {
    if (!supported) return false;
    const r = await window.electronAPI!.updater!.download();
    if (!r.ok && r.error) {
      errorMessage.value = r.error;
      state.value = 'error';
    }
    return r.ok;
  }

  async function install(): Promise<boolean> {
    if (!supported) return false;
    const r = await window.electronAPI!.updater!.install();
    if (!r.ok && r.error) errorMessage.value = r.error;
    return r.ok;
  }

  async function openLog() {
    if (!supported) return;
    await window.electronAPI!.updater!.openLog();
  }

  onMounted(() => {
    if (!supported || subscribed.value) return;
    unsubscribe = window.electronAPI!.updater!.onState(apply);
    subscribed.value = true;
    // 先订阅再拉初值：反序会丢掉「订阅建立前」已经发生的状态变化
    void refresh();
  });

  onBeforeUnmount(() => {
    unsubscribe?.();
    unsubscribe = null;
    subscribed.value = false;
  });

  const statusText = computed(() => {
    if (state.value === 'error' && errorMessage.value) return errorMessage.value;
    if (!installable.value && rejectReason.value) return rejectReason.value;
    return describeUpdateState(state.value);
  });

  const busy = computed(
    () => state.value === 'checking' || state.value === 'downloading' || state.value === 'installing'
  );

  return {
    supported,
    state,
    currentVersion,
    availableVersion,
    releaseNotes,
    forceupdate,
    mandatory,
    installable,
    rejectReason,
    percent,
    bytesPerSecond,
    errorMessage,
    statusText,
    busy,
    check,
    download,
    install,
    openLog,
    refresh,
  };
}
