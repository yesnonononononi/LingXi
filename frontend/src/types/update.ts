/**
 * 自动更新的类型契约（渲染层）。
 *
 * ⚠️ 这些类型描述的是 main 进程经 IPC 下发的形态，与
 *    frontend/electron/updater.cjs 的 emit() 一一对应。改一侧必须同步另一侧 ——
 *    字段名不一致的后果是 UI 静默显示空值（TS 在 IPC 边界上无法做运行期校验）。
 */

/**
 * 更新状态机的状态。
 *
 * - `disabled`     当前环境不支持（开发态 / 非 Windows / 缺依赖）
 * - `idle`         已启用、尚未检查
 * - `checking`     正在检查
 * - `not-available`已是最新（或版本被拒，见 rejectReason）
 * - `available`    发现新版本，等待用户确认下载
 * - `downloading`  下载中（带 percent）
 * - `downloaded`   下载完成且已通过 sha512 校验，等待安装
 * - `installing`   正在安装并重启
 * - `error`        出错
 */
export type UpdateState =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface UpdateStatePayload {
  state: UpdateState;
  /** 当前运行版本（主进程 app.getVersion()，来自 package.json） */
  currentVersion: string;
  /** 远端可用的版本号（仅在有 pending 时存在） */
  availableVersion?: string;
  /** Release 正文（即 changeLog） */
  releaseNotes?: string;
  /** 是否强制更新。⚠️ 该值已经过 Ed25519 验签，未签名时恒为 false */
  forceupdate?: boolean;
  /**
   * 是否不可跳过。
   * ⚠️ 与 forceupdate 语义不同：mandatory 还包含「当前版本低于 minSupportedVersion」，
   *    即当前版本已不受支持、升级不是可选项。渲染层判「不可跳过」应看这个字段。
   */
  mandatory?: boolean;
  /** 该更新是否可安装。验签失败或版本被拒时为 false */
  installable?: boolean;
  /** 不可安装的原因（installable=false 时有值） */
  rejectReason?: string | null;
  /** 下载进度 0-100（downloading 时有值） */
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  /** 错误信息（error 时有值） */
  error?: string;
  /** disabled 的原因 */
  reason?: string;
}

/**
 * 渲染层挂载时拉取的初值。
 *
 * ⚠️ 必须带 phase 与 progress：设置页重开时要还原「下载中 / 已下载 / 出错」，
 *    只回 pending 会让任何 pending 都被显示成 available（历史缺口）。
 */
export interface UpdateLookupResult {
  currentVersion: string;
  /** 主进程是否启用了更新器 */
  enabled: boolean;
  /** 当前状态机阶段（与 UpdateState 同域） */
  phase: UpdateState;
  /** 最近一次错误文案（phase==='error' 时有效） */
  error: string | null;
  /** 下载进度快照（downloading / downloaded 时有效） */
  progress: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  };
  pending: {
    version: string;
    releaseNotes: string;
    forceupdate: boolean;
    mandatory: boolean;
    installable: boolean;
    rejectReason: string | null;
  } | null;
}

export interface UpdateActionResult {
  ok: boolean;
  error?: string;
}

/**
 * 解析 Release 正文里由 scripts/sign-update.mjs 生成的声明块。
 *
 * ⚠️ 仅供**展示**（例如把 forceupdate 标记渲染成角标）。
 *    **不要**用它决定是否强制更新 —— 真正的判据是主进程验签后的 `forceupdate` 字段。
 *    在渲染层二次解析一份未签名的正文，等于把信任边界挪到了错误的一侧。
 */
export function extractUpdateClaimForDisplay(releaseNotes: string | undefined): {
  forceupdate: boolean;
  minSupportedVersion: string | null;
} {
  if (!releaseNotes) return { forceupdate: false, minSupportedVersion: null };
  const m = releaseNotes.match(/```lx-update\s*\n([\s\S]*?)```/i);
  if (!m) return { forceupdate: false, minSupportedVersion: null };

  const map: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    map[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return {
    forceupdate: map.forceupdate === 'true',
    minSupportedVersion: map.minSupportedVersion || null,
  };
}

/**
 * 从 Release 正文中剥掉 lx-update 声明块，只留给人看的更新说明。
 *
 * 理由：声明块里的 signature 是一长串 base64，直接展示给用户毫无意义且显得像故障。
 */
export function stripUpdateClaim(releaseNotes: string | undefined): string {
  if (!releaseNotes) return '';
  return releaseNotes
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```lx-update\s*\n[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 状态 → 中文文案（集中一处，避免各组件各写一套导致口径不一） */
export function describeUpdateState(state: UpdateState): string {
  switch (state) {
    case 'disabled':
      return '当前环境不支持自动更新';
    case 'idle':
      return '已是最新版本';
    case 'checking':
      return '正在检查更新…';
    case 'not-available':
      return '已是最新版本';
    case 'available':
      return '发现新版本';
    case 'downloading':
      return '正在下载…';
    case 'downloaded':
      return '下载完成，可以安装';
    case 'installing':
      return '正在安装并重启…';
    case 'error':
      return '检查更新失败';
    default:
      return '';
  }
}

/** 字节数 → 人类可读（用于下载速度/进度展示） */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
