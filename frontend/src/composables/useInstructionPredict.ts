import {computed, getCurrentInstance, onBeforeUnmount, ref, watch, type Ref} from 'vue';
import {InstructionAPI} from '../services/instruction';
import {isOk} from '../utils/api';

/** 输入框里「下一条指令」建议的空闲判定：终态后停手 5 秒才认为用户真的在看结果。 */
export const PREDICT_IDLE_MS = 5000;

export interface InstructionPredictFacts {
  /** 当前会话 id（根会话）。 */
  sessionId: Ref<string | number | null | undefined>;
  /** 当前会话所属根会话 id；子会话这里指向根，根会话自身为 0 或等于 sessionId。 */
  rootSessionId: Ref<string | number | null | undefined>;
  /** 要预测的那一轮（最后一轮）。 */
  turnId: Ref<string | null | undefined>;
  /** 该轮是否已终态（由 turns 摘要的 status 判定，不猜）。 */
  turnTerminal: Ref<boolean>;
  /** 功能是否开启：后端以「预测模型为空」表示关闭，前端据此省掉无效请求。 */
  enabled: Ref<boolean>;
}

/**
 * 子会话判定（前端尽力而为的一次简单拦截）。
 *
 * <p>权威判定在后端：子会话的 next 会被直接拒绝。这里只为了少打一次必然失败的请求，
 * 不追求覆盖全部边角 —— 根会话的 rootSessionId 可能是 0 也可能等于自身，两种都按根处理。</p>
 */
export function isSubSessionOf(rootSessionId: string | number | null | undefined,
                               sessionId: string | number | null | undefined): boolean {
  if (rootSessionId == null || sessionId == null) return false;
  const root = String(rootSessionId);
  return root !== '0' && root !== String(sessionId);
}

/**
 * 该向哪一轮要预测；返回 null 表示这个时刻不该发请求。
 *
 * <p>为什么不做「轮次里是否有 Agent 正文」的判断：那是后端的事（缺正文时后端返回空），
 * 前端复制一份判定只会两头不一致。</p>
 */
export function resolvePredictTarget(facts: {
  sessionId: string | number | null | undefined;
  rootSessionId: string | number | null | undefined;
  turnId: string | number | null | undefined;
  turnTerminal: boolean;
  enabled: boolean;
}): { sessionId: string; turnId: string } | null {
  if (!facts.enabled) return null;
  if (facts.sessionId == null || facts.turnId == null) return null;
  if (!facts.turnTerminal) return null;
  if (isSubSessionOf(facts.rootSessionId, facts.sessionId)) return null;
  return {sessionId: String(facts.sessionId), turnId: String(facts.turnId)};
}

/**
 * 指令预测：轮次终态并静止 {@link PREDICT_IDLE_MS} 毫秒后，向后端要一条「下一条指令」。
 *
 * <p><b>为什么由前端计时</b>：后端不知道用户是刚跑完还是已经盯着结果看了十秒。
 * 用户在这 5 秒内自己开始打字或继续发消息，请求就不该发出 —— 预测的是「他接下来会说什么」，
 * 他已经在说了，预测就是噪音。</p>
 *
 * <p><b>结果只信后端</b>：同一轮重复请求后端返回同一条（已落库），前端不缓存、不改写、不拼接。</p>
 */
export function useInstructionPredict(facts: InstructionPredictFacts, idleMs = PREDICT_IDLE_MS) {
  /** 当前建议正文；空串表示没有可展示的建议。 */
  const suggestion = ref('');
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 请求序号：迟到的响应不得覆盖后发目标的结果（切会话时最容易踩）。 */
  let sequence = 0;

  const target = computed(() => resolvePredictTarget({
    sessionId: facts.sessionId.value,
    rootSessionId: facts.rootSessionId.value,
    turnId: facts.turnId.value,
    turnTerminal: facts.turnTerminal.value,
    enabled: facts.enabled.value,
  }));

  const cancel = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    sequence++;
  };

  const clear = (): void => {
    cancel();
    suggestion.value = '';
  };

  const request = async (sessionId: string, turnId: string, seq: number): Promise<void> => {
    try {
      const result = await InstructionAPI.next(sessionId, turnId);
      if (seq !== sequence) return;
      const text = isOk(result.code) ? (result.data?.nextInstruction ?? '').trim() : '';
      // 换会话/换轮次的守卫已在 seq 上做过；这里只写非空结果，空表示「后端认为不值得预测」。
      suggestion.value = text;
    } catch (error) {
      // 预测是锦上添花：失败静默，绝不打扰正在打字的用户。
      console.error('获取指令预测失败:', error);
      if (seq === sequence) suggestion.value = '';
    }
  };

  watch(target, next => {
    clear();
    if (next == null) return;
    const seq = sequence;
    timer = setTimeout(() => {
      timer = null;
      void request(next.sessionId, next.turnId, seq);
    }, idleMs);
  }, {immediate: true});

  // 只有挂在组件里才存在卸载钩子；纯函数式调用（单元测试 / 无宿主场景）不需要清理。
  if (getCurrentInstance()) onBeforeUnmount(cancel);

  return {suggestion, clear};
}
