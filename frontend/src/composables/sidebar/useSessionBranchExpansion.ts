import {computed, type ComputedRef, ref} from 'vue';
import type {ChatSession} from '../../types/chat';

/**
 * 侧边栏「会话 → 子会话（子代理）」分支的展开态。
 *
 * <p><b>为什么必须默认折叠：</b>分支是二级信息。旧实现把状态记成「折叠集合」（默认不在集合里 ⇒
 * 默认展开），于是一打开侧边栏就是「工作区 > 5 个会话 > 每个会话下 2~3 个 Agent 名」的满屏子树，
 * 真正要点的会话反而被淹掉（用户实测反馈）。默认折叠后，一级列表回到「一眼看完」的长度。</p>
 *
 * <p><b>为什么还要「自动展开当前分支」：</b>折叠不能把用户正在看的东西藏起来。所以激活会话
 * （或激活子会话所属的根会话）的分支始终展开；用户切走后自动回落成折叠。</p>
 *
 * <p><b>为什么需要手动覆盖：</b>自动展开若是纯派生值，用户折叠「当前正在看的会话」会被下一次
 * `activeSessionId` 变化（甚至同 id 重算）弹回去，表现为「点了没反应」。因此手动操作写成显式
 * 覆盖记录（`true`/`false`），覆盖存在时不再跟随激活态。</p>
 *
 * <p><b>作用域：</b>手动覆盖会写进本机一份 localStorage（键 `lingxi.sidebar.branchExpansion`），
 * 所以重启后用户的折叠选择仍在；<b>只存覆盖、不存派生出来的展开态</b> —— 后者每次都要按
 * 「当前所在分支」重算，存下来就会让上次看的会话在下次启动时仍然展开，与默认折叠的契约打架。
 * 写入时按「当前还存在的会话」裁剪，会话删了不留孤儿键（列表未加载时先不裁，否则会抹掉刚点的）。</p>
 */
export interface SessionBranchExpansionSources {
  /** 全量会话（含各组与未分组），用于把激活的子会话反查回它的所属根会话。 */
  sessions: ComputedRef<ChatSession[]>;
  activeSessionId: ComputedRef<string | null>;
  /** 当前打开的二级会话（子代理）；为空表示用户停在根会话上。 */
  activeSubSessionId?: ComputedRef<string | null | undefined>;
}

export interface SessionBranchExpansion {
  /** 该会话的子会话分支是否展开（模板直接调用，读的是响应式覆盖表）。 */
  isBranchExpanded: (sessionId: string | number) => boolean;
  /** 显式设置展开态：BranchedMenu 的 `toggleChild` 会给「目标态」而不仅是切换。 */
  setBranchExpanded: (sessionId: string | number, open: boolean) => void;
  /** 切换展开态（亮色分支的箭头按钮用）。 */
  toggleBranch: (sessionId: string | number) => void;
  /** 当前自动展开的根会话 id（供调试/断言；`null` 表示没有激活会话）。 */
  autoExpandedSessionId: ComputedRef<string | null>;
}

/**
 * 手动覆盖的持久化键（本机一份，键 = 会话 id）。
 *
 * <p><b>为什么只存「覆盖」而不是「全部展开态」</b>：没有覆盖时的展开态是**派生值**
 * （只展开当前所在分支）。把派生结果也存下来，会让「上次看的会话」在下次启动时仍然展开，
 * 与「只看当前分支」的契约打架 —— 存的是用户意图，不是计算结果。</p>
 */
const STORAGE_KEY = 'lingxi.sidebar.branchExpansion';

/** 读取失败一律当空（隐私模式、配额满、脏数据都不该让侧边栏渲染不出来）。 */
function readOverrides(): Record<string, boolean> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 写入覆盖表，顺手按「当前还存在的会话」裁剪。
 *
 * <p>会话删除后它的键不该永远留着 —— 但会话列表还没加载完时（空列表）不能裁，
 * 那会把用户刚刚的点击全部抹掉。所以只在拿到列表时裁。</p>
 */
function writeOverrides(overrides: Record<string, boolean>, sessions: readonly { id: string | number }[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    let payload = overrides;
    if (sessions.length > 0) {
      const alive = new Set(sessions.map(session => String(session.id)));
      payload = {};
      for (const [key, value] of Object.entries(overrides)) {
        if (alive.has(key)) payload[key] = value;
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 写不进去只是丢一次偏好，不影响任何功能路径。
  }
}

export function useSessionBranchExpansion(sources: SessionBranchExpansionSources): SessionBranchExpansion {
  const {sessions, activeSessionId, activeSubSessionId} = sources;

  /** 手动覆盖：`undefined` 表示「跟随激活态」，故不能用 Set 记录。 */
  const overrides = ref<Record<string, boolean>>(readOverrides());

  const autoExpandedSessionId = computed<string | null>(() => {
    const subId = activeSubSessionId?.value;
    if (subId !== undefined && subId !== null && String(subId) !== '') {
      const owner = sessions.value.find(session =>
        (session.subSessions ?? []).some(sub => String(sub.id) === String(subId)));
      if (owner) return String(owner.id);
    }
    const rootId = activeSessionId.value;
    return rootId === null || rootId === undefined || String(rootId) === '' ? null : String(rootId);
  });

  const isBranchExpanded = (sessionId: string | number): boolean => {
    const key = String(sessionId);
    const override = overrides.value[key];
    if (override !== undefined) return override;
    return key === autoExpandedSessionId.value;
  };

  const setBranchExpanded = (sessionId: string | number, open: boolean): void => {
    overrides.value = {...overrides.value, [String(sessionId)]: open};
    writeOverrides(overrides.value, sessions.value);
  };

  const toggleBranch = (sessionId: string | number): void => {
    setBranchExpanded(sessionId, !isBranchExpanded(sessionId));
  };

  return {isBranchExpanded, setBranchExpanded, toggleBranch, autoExpandedSessionId};
}
