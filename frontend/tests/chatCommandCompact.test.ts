import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupMutantTemp,
  importMutantModule,
  readMutantSource,
  readMutationFlag,
  replaceExportedFunction,
  type MutationTable,
} from './support/mutantSource';

/**
 * `/compact` 的手工压缩命令契约。
 *
 * <p>三条语义逐条钉死：</p>
 * <ol>
 *   <li>它必须是「已知命令」—— 漏进白名单的话 `/compact` 会被当成一句普通提问发给模型；</li>
 *   <li>它不接受正文，带正文提交必须被拒绝而不是静默吞掉；</li>
 *   <li>菜单项 id 与白名单必须一一对应（命令面漂移是历史缺陷）。</li>
 * </ol>
 *
 * <p>变异自检：`--mutation=body-allowed`（去掉「不接受正文」判定）、
 * `--mutation=compact-unknown`（把 compact 从白名单里删掉）、
 * `--mutation=menu-missing`（改掉菜单项 id 制造漂移）。</p>
 */

const COMMAND_PARSER = 'src/utils/chatCommand.ts';
const INPUT_AREA = 'src/components/chat/ChatInputArea.vue';
const AGENT_API = 'src/services/agent.ts';

const MUTATIONS: MutationTable = {
  // 注回缺陷：带正文也照常执行（正文被静默丢弃）
  'body-allowed': source => replaceExportedFunction(source, 'hasUnexpectedCommandBody',
    'export function hasUnexpectedCommandBody(draft: ChatCommandDraft | null): boolean {\n'
    + '  return draft !== null && false;\n'
    + '}\n'),
  // 注回缺陷：命令不在白名单里（/compact 会被当普通文本发给模型）
  'compact-unknown': source => {
    assert.ok(source.includes("  'compact',\n"), '补丁锚点失效：白名单里找不到 compact');
    return source.replace("  'compact',\n", '');
  },
  // 注回缺陷：菜单项 id 与白名单漂移
  'menu-missing': source => {
    assert.ok(source.includes("id: 'compact',"), '补丁锚点失效：找不到 compact 菜单项');
    return source.replace("id: 'compact',", "id: 'compact-typo',");
  },
  // 注回缺陷：压缩沿用实例默认超时（服务端压完写回了，客户端却把结果丢弃）
  'compact-default-timeout': source => {
    assert.ok(source.includes('{ timeout: COMPACT_TIMEOUT_MS },'), '补丁锚点失效：找不到压缩超时实参');
    return source.replace('{ timeout: COMPACT_TIMEOUT_MS },', 'undefined,');
  },
  // 注回缺陷：压缩在途照样允许发送（与写回上下文的操作抢同一份正文）
  'no-compact-gate': source => {
    assert.ok(source.includes('if (props.isCompacting) return false;'), '补丁锚点失效：找不到发送闸门');
    return source.replace('if (props.isCompacting) return false;', 'void 0;');
  },
};

const PARSER_MUTATIONS: MutationTable = {
  'body-allowed': MUTATIONS['body-allowed']!,
  'compact-unknown': MUTATIONS['compact-unknown']!,
};
const INPUT_AREA_MUTATIONS: MutationTable = {
  'menu-missing': MUTATIONS['menu-missing']!,
  'no-compact-gate': MUTATIONS['no-compact-gate']!,
};
const AGENT_MUTATIONS: MutationTable = {
  'compact-default-timeout': MUTATIONS['compact-default-timeout']!,
};

const mutation = readMutationFlag();

interface ChatCommandModule {
  CHAT_COMMAND_NAMES: readonly string[];
  CHAT_COMMAND_NO_BODY: readonly string[];
  isChatCommandName: (name: string) => boolean;
  isBodylessChatCommand: (name: string) => boolean;
  hasUnexpectedCommandBody: (draft: {name: string; body: string} | null) => boolean;
  isCommandTokenOnly: (text: string) => boolean;
  resolveChatSendDraft: (text: string, planMode: boolean) => {text: string; requirePlan: boolean; command: string | null};
}

let cachedParser: ChatCommandModule | null = null;
async function loadParser(): Promise<ChatCommandModule> {
  if (!cachedParser) {
    cachedParser = await importMutantModule<ChatCommandModule>(COMMAND_PARSER, mutation, PARSER_MUTATIONS);
  }
  return cachedParser;
}

test.after(() => {
  cleanupMutantTemp();
});

test('变异名必须在变异表内（防止变异静默失效）', () => {
  if (!mutation) {
    return;
  }
  assert.ok(MUTATIONS[mutation], `未知变异: ${mutation}`);
});

test('/compact 是已知命令：不带正文的提交被识别为 compact', async () => {
  const {isChatCommandName, resolveChatSendDraft} = await loadParser();
  assert.equal(isChatCommandName('compact'), true, '/compact 必须是已知命令，否则会被当普通文本发给模型');
  assert.equal(isChatCommandName('Compact'), true, '命令名判定大小写不敏感');

  const draft = resolveChatSendDraft('/compact', false);
  assert.equal(draft.command, 'compact', '必须识别出 compact 命令');
  assert.equal(draft.text, '', '纯命令没有正文');
  assert.equal(draft.requirePlan, false, '/compact 不得顺带切 plan 模式');
});

test('/compact 带正文必须被拒绝（前端与后端各校验一次）', async () => {
  const {hasUnexpectedCommandBody, isBodylessChatCommand, resolveChatSendDraft} = await loadParser();
  assert.equal(isBodylessChatCommand('compact'), true, 'compact 属于「不接受正文」的命令');

  assert.equal(hasUnexpectedCommandBody({name: 'compact', body: '保留部署相关的部分'}), true,
    '带正文必须拒绝，否则正文被静默吞掉');
  assert.equal(hasUnexpectedCommandBody({name: 'compact', body: '   '}), false, '纯空白不算正文');
  assert.equal(hasUnexpectedCommandBody({name: 'compact', body: ''}), false, '空正文是合法提交');
  assert.equal(hasUnexpectedCommandBody(null), false, '普通文本不受影响');
  // 其它命令的正文照旧合法：只有白名单里的「不接受正文」命令才拦
  assert.equal(hasUnexpectedCommandBody({name: 'plan', body: '把这段重构成策略模式'}), false,
    '/plan 带正文是正常用法');
  assert.equal(hasUnexpectedCommandBody({name: 'agent', body: '用这个'}), false, '其它命令不受影响');

  // 提交层解析出的正文也要能被判定（真实调用路径：draft.text 就是命令之后的正文）
  const withBody = resolveChatSendDraft('/compact 保留部署相关的部分', false);
  assert.equal(withBody.command, 'compact', '带正文时仍能识别出命令名，判定才可能生效');
  assert.equal(withBody.text, '保留部署相关的部分', '正文原样解析出来，交给校验层判定');
});

test('整段 `/compact` 是一个命令 token：允许清空输入框', async () => {
  const {isCommandTokenOnly} = await loadParser();
  assert.equal(isCommandTokenOnly('/compact'), true, '纯命令提交后清空输入框不损失信息');
  assert.equal(isCommandTokenOnly('/comp'), true, '菜单筛选前缀也不含正文');
  assert.equal(isCommandTokenOnly('/compact 保留部署相关的部分'), false, '带正文时绝不允许清空');
});

test('前端提交前真的调用了正文校验（源码守卫）', () => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  assert.ok(source.includes('hasUnexpectedCommandBody('), '提交路径必须调用统一的正文校验');
  const guard = extractIfBlock(source, 'if (hasUnexpectedCommandBody(');
  assert.ok(guard.includes('return'), '校验命中必须终止本次提交');
  assert.ok(guard.includes('focusInput()'), '拒绝后应把焦点还给输入框，正文留在原位');
});

test('菜单 id 与白名单不漂移：compact 两边都有', async () => {
  const {CHAT_COMMAND_NAMES, CHAT_COMMAND_NO_BODY} = await loadParser();
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  assert.ok(CHAT_COMMAND_NAMES.includes('compact'), '白名单必须包含 compact');
  assert.ok(CHAT_COMMAND_NO_BODY.includes('compact'), '不接受正文的白名单必须包含 compact');
  assert.ok(source.includes("id: 'compact',"), '快捷指令菜单必须有 compact 项');
  assert.ok(source.includes("emit('compactContext')"), '菜单项必须派发 compactContext，由宿主调接口');
});

test('压缩请求必须显式放宽超时：默认 10s 会在服务端已写回后丢弃结果', () => {
  const source = readMutantSource(AGENT_API, mutation, AGENT_MUTATIONS);
  const call = extractIfBlock(source, 'static async compactContext(');
  assert.ok(call.includes('timeout: COMPACT_TIMEOUT_MS'),
    '压缩是同步模型调用，用实例默认超时会让「已压完并写回」的结果被客户端判定为失败');
  assert.ok(source.includes('const COMPACT_TIMEOUT_MS'), '超时预算必须是命名常量，不能在调用点写魔数');
});

test('压缩在途：有可见 loading，且发送被挡住', () => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  assert.ok(source.includes('data-testid="chat-compact-loading"'), '压缩在途必须有可见状态行');
  assert.ok(source.includes("t('chat.compact.loading')"), 'loading 文案必须走 i18n');
  assert.ok(source.includes('if (props.isCompacting) return false;'),
    '压缩在途不得进入可发送态：此时上下文正在被改写');
  assert.ok(source.includes('props.isCompacting) return;'), 'Enter 提交路径同样要被闸门挡住');
});

/** 取出 `if (...) { ... }` 的**语句块**（先配平圆括号，再配平大括号）。 */
function extractIfBlock(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `锚点不存在: ${anchor}`);
  // 必须先把实参的圆括号配平：锚点后面第一对 `{}` 往往就是实参对象字面量，
  // 直接按大括号判块会把它当成语句块，于是「块里没有 return」这种假红。
  let paren = 0;
  let index = start + anchor.length - 1;
  for (; index < source.length; index += 1) {
    if (source[index] === '(') paren += 1;
    else if (source[index] === ')') {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  assert.ok(index < source.length, `圆括号未配平: ${anchor}`);
  const open = source.indexOf('{', index);
  assert.ok(open >= index, `找不到语句块: ${anchor}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return assert.fail(`花括号未配平: ${anchor}`);
}
