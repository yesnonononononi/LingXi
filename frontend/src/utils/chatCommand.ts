import type {ChatMode} from '../types/chat';

/**
 * 输入栏斜杠命令的**纯解析层**。
 *
 * <p><b>为什么要把解析抽出来</b>：命令的历史实现是「watch(inputText) 看到 /plan 就改写文本」，
 * 于是任何写入 inputText 的路径（宿主 setInputText 回填历史消息、prompt 优化草稿回填、
 * 粘贴、编辑重发）都会被当成「用户敲了命令」，静默吞掉用户内容。解析与文本状态解耦之后，
 * 副作用只能发生在两个明确时机：用户显式选中菜单项，或 submit 时解析本次输入。</p>
 *
 * <p>本模块是纯函数，没有任何 Vue 依赖（只引用类型），因此可以被单测逐条钉死。</p>
 */

/**
 * 命令名清单：必须与 ChatInputArea 的快捷指令菜单 id 一一对应，
 * 因此这里的「已知命令」判定同时决定了「整段输入是不是一个命令 token」。
 */
export const CHAT_COMMAND_NAMES: readonly string[] = [
  'plan',
  'model',
  'workspace',
  'export',
  'team',
  'add-team',
  'agent',
  'permission',
  'mcp',
  'skill',
  'optimize-prompt',
  'settings',
];

/** 斜杠命令的解析结果：命令名 + 命令之后的正文。 */
export interface ChatCommandDraft {
  /** 命令名（保持用户原样大小写，判定已知命令时另行规范化）。 */
  name: string;
  /** 命令后面的正文（已去掉命令与正文之间的空白）；没有正文时为空串。 */
  body: string;
}

/** 中文说明：只有「/命令名」后跟空白或直接结束，才算命令；「/plan把这段」这类连写不解释成命令。 */
const COMMAND_PATTERN = /^\/([A-Za-z][A-Za-z0-9-]*)(\s[\s\S]*)?$/;

/** 整段输入只是一个命令 token（允许是命令名前缀，如 "/pl"）时使用的形态判据。 */
const TOKEN_ONLY_PATTERN = /^\/([A-Za-z][A-Za-z0-9-]*)?\s*$/;

/**
 * 解析整段输入里的斜杠命令。
 *
 * @param text 输入框全文
 * @returns 命令草稿；不是「/命令名」形态时返回 null（调用方据此按普通文本处理）
 */
export function resolveChatCommandDraft(text: string): ChatCommandDraft | null {
  if (typeof text !== 'string') {
    return null;
  }
  const matched = COMMAND_PATTERN.exec(text);
  if (!matched) {
    return null;
  }
  const name = matched[1] ?? '';
  if (name === '') {
    return null;
  }
  return { name, body: (matched[2] ?? '').replace(/^\s+/, '') };
}

/**
 * 命令名是否为已知命令（大小写不敏感）。
 *
 * @param name 待判定命令名
 * @returns true = 是输入栏支持的命令
 */
export function isChatCommandName(name: string): boolean {
  const normalized = (name ?? '').toLowerCase();
  return normalized !== '' && CHAT_COMMAND_NAMES.includes(normalized);
}

/**
 * 整段输入是否「只是一个命令 token」，没有任何正文。
 *
 * <p>允许命令名前缀（用户还在筛选菜单，如 "/pl"），因为此时清空不损失任何用户内容；
 * 而 "/帮我修这个bug"、"<code>/plan 正文</code>" 这类带正文的输入一律返回 false ——
 * 它们承载用户已经写下的内容，绝不允许被清空。</p>
 *
 * @param text 输入框全文
 * @returns true = 可以安全清空
 */
export function isCommandTokenOnly(text: string): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  const matched = TOKEN_ONLY_PATTERN.exec(text);
  if (!matched) {
    return false;
  }
  const token = (matched[1] ?? '').toLowerCase();
  // 只有一个 "/"：菜单还在筛选阶段，清掉它不损失信息。
  if (token === '') {
    return true;
  }
  return CHAT_COMMAND_NAMES.some(name => name.startsWith(token));
}

/**
 * 菜单选中命令后应当保留的文本。
 *
 * <p>这是**唯一**的清空判据：所有命令共用它，不允许每个菜单项各写一套清空逻辑。</p>
 *
 * @param text 选中命令前的输入框全文
 * @returns 清空后的文本（整段只是一个命令 token 时为空串，否则原样保留用户正文）
 */
export function resolveTextAfterCommandSelect(text: string): string {
  return isCommandTokenOnly(text) ? '' : text;
}

/**
 * 解析 submit 时输入里的命令调用。
 *
 * @param text 输入框全文
 * @returns 已知命令的调用（含正文）；不是已知命令时返回 null
 */
export function resolveChatCommandInvocation(text: string): ChatCommandDraft | null {
  const draft = resolveChatCommandDraft(text);
  if (!draft || !isChatCommandName(draft.name)) {
    return null;
  }
  return { name: draft.name.toLowerCase(), body: draft.body };
}

/** 本次发送的最终形态（submit 解析结果）。 */
export interface ChatSendDraft {
  /** 真正发给模型的正文（已剥离命令 token，正文一个字都不丢）。 */
  text: string;
  /** sendMessage 第 2 参：本轮是否以 plan 模式发送。 */
  requirePlan: boolean;
  /** 提交时识别出的命令名；null = 普通文本。 */
  command: string | null;
}

/**
 * 计算本次发送的正文与 plan 语义。
 *
 * <p>`/plan 把这段重构成策略模式` 在第 0 帧之前就被解析：模式切到 plan，正文原样保留进消息；
 * 而没有命令前缀的普通文本一律原样发送，plan 语义沿用受控模式当前值。</p>
 *
 * @param text 输入框全文
 * @param planMode 受控 plan 模式的当前值
 * @returns 发送草稿
 */
export function resolveChatSendDraft(text: string, planMode: boolean): ChatSendDraft {
  const invocation = resolveChatCommandInvocation(text);
  if (!invocation) {
    return { text, requirePlan: planMode === true, command: null };
  }
  return {
    text: invocation.body,
    requirePlan: invocation.name === 'plan' ? true : planMode === true,
    command: invocation.name,
  };
}

/**
 * 布尔开关到受控模式值的映射。
 *
 * @param planMode 是否开启 plan 模式
 * @returns ChatMode 契约值
 */
export function toChatMode(planMode: boolean): ChatMode {
  return planMode ? 'plan' : 'auto';
}
