import { CHAT_INPUT_COMMAND_KEYS } from '../types/chatInputCommands';
import type { ChatInputCommands } from '../types/chatInputCommands';
// 仅类型导入（编译后被擦除，不产生运行时依赖）：把契约与组件的 defineExpose 绑在一起。
import type ChatInputArea from '../components/chat/ChatInputArea.vue';

/**
 * 编译期一致性断言（本文件的核心价值所在）。
 *
 * <p><b>为什么光有接口不够：</b>只把调用方标成 `ChatInputCommands` 并不能阻止"组件侧少 expose 一项"
 * —— 我们对 `inputAreaRef` 的赋值来自模板 `ref="inputAreaRef"`，而 vue-tsc **不校验模板 ref 赋值**
 * 对 `Ref<T>` 的兼容性（已实测：给接口加一个组件不存在的成员，`vue-tsc` 仍然 0 错）。
 * 换句话说，纯声明式契约是"纸面契约"，实现漂移不会被抓到。</p>
 *
 * <p>下面两条断言把两者钉死：
 * ① `组件侧 ⊇ 契约`：组件 expose 必须**至少**提供契约里的每一项（少一项就编不过）；
 * ② `契约 ⊇ 组件侧同名项`：契约不得比实现更宽（例如把 `Promise<void>` 写成 `Promise<unknown>`、
 *    或把 `(id: X) => void` 放宽成 `(id: unknown) => void` 都会失败）。
 * 两条同时成立 ⇒ 每一项签名与实现**互为赋值**，任何一侧改动都会在 `vue-tsc` 阶段报错。</p>
 */
type ExposedInstance = InstanceType<typeof ChatInputArea>;
/** 只取契约里出现的那 11 个键，避免把 `$props` / `$emit` 等内置成员卷进比较。 */
type ExposedCommands = Pick<ExposedInstance, keyof ChatInputCommands>;
/** `true` 约束：条件不成立时 `Assert<false>` 会因不满足 `extends true` 而报错。 */
type Assert<T extends true> = T;

// ① 组件 expose 覆盖契约（漏 expose 会在这一行报错）
export type _CommandsSatisfiedByComponent = Assert<ExposedCommands extends ChatInputCommands ? true : false>;
// ② 契约不放宽实现（签名被写宽会在这一行报错）
export type _CommandsNotWiderThanComponent = Assert<ChatInputCommands extends ExposedCommands ? true : false>;

/**
 * 校验目标对象是否提供了命令面的全部 11 项，且每项都是函数。
 *
 * @param target 待校验对象（通常是 `inputAreaRef.value`，未挂载时为 null/undefined）
 * @param where 调用点标识（写进日志，便于在多处调用时定位）
 * @returns 缺失或非函数的键名列表；空数组表示契约完整
 */
export function assertChatInputCommands(target: unknown, where: string): readonly string[] {
  if (!import.meta.env.DEV) return [];

  if (target === null || target === undefined) {
    // 未挂载/已卸载属于合法的窗口期，不是契约违规；仅提示，便于排查调用时机。
    console.warn(`[ChatInputCommands] ${where}: 目标为空（输入区可能尚未挂载或已卸载），跳过命令面自检`);
    return [];
  }

  const record = target as Record<string, unknown>;
  const missing: string[] = [];
  const notFunction: string[] = [];

  for (const key of CHAT_INPUT_COMMAND_KEYS) {
    const value = record[key];
    if (value === undefined) {
      missing.push(key);
      continue;
    }
    if (typeof value !== 'function') notFunction.push(key);
  }

  if (missing.length > 0 || notFunction.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`缺失 ${missing.length} 项：${missing.join(', ')}`);
    if (notFunction.length > 0) parts.push(`非函数 ${notFunction.length} 项：${notFunction.join(', ')}`);
    console.error(
      `[ChatInputCommands] ${where}: 命令面契约不完整 —— ${parts.join('；')}。`
      + ` 请检查 ChatInputArea.vue 的 defineExpose 与 types/chatInputCommands.ts 是否一致。`
    );
  }

  return [...missing, ...notFunction];
}
