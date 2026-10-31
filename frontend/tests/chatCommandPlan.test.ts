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
 * 缺陷 2 回归用例：`/plan` 模式切换不得清空用户已输入内容。
 *
 * <p>三条清空路径逐条覆盖：</p>
 * <ol>
 *   <li>命令菜单选中 plan（`selectCommand`）—— 只有「整段输入就是一个命令 token」才允许清空；</li>
 *   <li>宿主 `setInputText` 回填（编辑重发 / 提示词回填）—— 文本写入不触发任何命令副作用；</li>
 *   <li>`/plan 带正文` 提交 —— 模式切到 plan，正文一个字都不许丢。</li>
 * </ol>
 *
 * <p>变异自检：`--mutation=clear-all`（恢复「只要 / 开头就整段清空」）、
 * `--mutation=watch-rewrite`（恢复 watch 改写文本执行命令）、
 * `--mutation=send-ignore-plan`（提交时不解析命令、不切模式）。</p>
 */

const COMMAND_PARSER = 'src/utils/chatCommand.ts';
const INPUT_AREA = 'src/components/chat/ChatInputArea.vue';
const CHAT_VIEW = 'src/views/chat/ChatView.vue';

const MUTATIONS: MutationTable = {
  // 注回原始缺陷：只要文本以 / 开头就整段清空
  'clear-all': source => replaceExportedFunction(source, 'resolveTextAfterCommandSelect',
    'export function resolveTextAfterCommandSelect(text: string): string {\n'
    + '  return text.startsWith(\'/\') ? \'\' : text;\n'
    + '}\n'),
  // 注回原始缺陷：watch(inputText) 看到 /plan 就切模式并改写文本
  'watch-rewrite': source => {
    const anchor = '/** 收起斜杠指令 / Agent / Skill 三层浮层（只动浮层，绝不触碰输入文本）。 */';
    assert.ok(source.includes(anchor), '补丁锚点失效：找不到收浮层的锚点');
    const injected = 'watch(inputText, (raw: string) => {\n'
      + '  if (raw.startsWith(\'/plan \') || raw === \'/plan\') {\n'
      + '    isPlanMode.value = true;\n'
      + '    inputText.value = raw.replace(/^\\/plan\\s*/, \'\');\n'
      + '    return;\n'
      + '  }\n'
      + '  if (raw.startsWith(\'/permission\')) {\n'
      + '    emit(\'openSettings\');\n'
      + '  }\n'
      + '});\n\n';
    return source.replace(anchor, `${injected}${anchor}`);
  },
  // 注回原始缺陷：提交时不解析命令，正文丢失且不切模式
  'send-ignore-plan': source => replaceExportedFunction(source, 'resolveChatSendDraft',
    'export function resolveChatSendDraft(text: string, planMode: boolean): ChatSendDraft {\n'
    + '  return { text: \'\', requirePlan: planMode === true, command: null };\n'
    + '}\n'),
  // 注回「白名单与菜单漂移」：菜单项 id 改名而白名单没跟上
  'command-drift': source => {
    assert.ok(source.includes("id: 'settings',"), '补丁锚点失效：找不到 settings 菜单项');
    return source.replace("id: 'settings',", "id: 'settings-typo',");
  },
};

/** 各文件适用的变异集合（其余变异名按正常源码返回）。 */
const PARSER_MUTATIONS: MutationTable = {
  'clear-all': MUTATIONS['clear-all']!,
  'send-ignore-plan': MUTATIONS['send-ignore-plan']!,
};
const INPUT_AREA_MUTATIONS: MutationTable = {
  'watch-rewrite': MUTATIONS['watch-rewrite']!,
  'command-drift': MUTATIONS['command-drift']!,
};
/** 宿主文件不参与本次变异（保持真实实现，避免补丁误打到别的文件）。 */
const CHAT_VIEW_MUTATIONS: MutationTable = {};

const mutation = readMutationFlag();

interface ChatCommandModule {
  resolveTextAfterCommandSelect: (text: string) => string;
  resolveChatCommandInvocation: (text: string) => {name: string; body: string} | null;
  resolveChatSendDraft: (text: string, planMode: boolean) => {text: string; requirePlan: boolean; command: string | null};
  isCommandTokenOnly: (text: string) => boolean;
  toChatMode: (planMode: boolean) => string;
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

// ---------- 路径 1：命令菜单选中 plan ----------

test('菜单选中命令只在「整段输入就是一个命令 token」时清空', async () => {
  const {resolveTextAfterCommandSelect} = await loadParser();
  // 用户只打了命令：清空是安全的
  assert.equal(resolveTextAfterCommandSelect('/plan'), '', '整段就是一个命令 token 时才允许清空');
  assert.equal(resolveTextAfterCommandSelect('/pl'), '', '菜单还在筛选时的命令前缀也不含用户正文');
  assert.equal(resolveTextAfterCommandSelect('/'), '', '只有一个 / 时清空不损失信息');
  assert.equal(resolveTextAfterCommandSelect('/plan  '), '', '命令 token 后的空白不算正文');
  // 用户已经写了正文：一个字都不许动
  assert.equal(resolveTextAfterCommandSelect('/帮我修这个bug'), '/帮我修这个bug',
    '以 / 开头的普通正文不得被整段清空');
  assert.equal(resolveTextAfterCommandSelect('/plan 把这段重构成策略模式'), '/plan 把这段重构成策略模式',
    '命令带正文时清空就是毁数据');
  assert.equal(resolveTextAfterCommandSelect('帮我把 /plan 那段的逻辑补上'), '帮我把 /plan 那段的逻辑补上',
    '命令不在开头的正文同样不许动');
  assert.equal(resolveTextAfterCommandSelect('/refactor the parser'), '/refactor the parser',
    '未知命令名后面的正文同样要保住');
});

test('selectCommand 的清空逻辑收敛到单一判据，且 plan 菜单项不再自带清空', () => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  const selectCommand = extractFunctionBody(source, 'const selectCommand = ');
  assert.ok(selectCommand.includes('resolveTextAfterCommandSelect(inputText.value)'),
    '菜单选中的清空必须走统一判据');
  assert.ok(!/inputText\.value\s*=\s*''/.test(selectCommand), 'selectCommand 不得再写一套无条件清空');

  const planAction = extractBlock(source, 'id: \'plan\',');
  assert.ok(!/inputText\.value\s*=/.test(planAction), 'plan 菜单项不得清空用户已写正文');
  assert.ok(planAction.includes('isPlanMode.value = true'), 'plan 菜单项必须切模式');
});

// ---------- 路径 2：宿主 setInputText 回填 ----------

test('宿主回填（setInputText）不可能触发命令副作用：watch(inputText) 不再改写文本', () => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  const watchers = extractBlocks(source, 'watch(inputText');
  assert.ok(watchers.length >= 1, '至少保留输入高度重算的 watch');
  for (const block of watchers) {
    assert.ok(!/inputText\.value\s*=/.test(block), `watch(inputText) 不得改写输入内容: ${block.slice(0, 80)}`);
    assert.ok(!/emit\(\s*'updateMode'/.test(block), 'watch(inputText) 不得派发模式变更');
    assert.ok(!/emit\(\s*'openSettings'/.test(block), 'watch(inputText) 不得打开设置');
    assert.ok(!/emit\(\s*'openSettingsTab'/.test(block), 'watch(inputText) 不得打开设置页签');
  }

  // 回填入口本身只做文本替换
  const expose = extractBlock(source, 'setInputText: (text: string) =>');
  assert.ok(expose.includes('writeInputText(text)'), 'setInputText 必须走统一的程序写入通道');
  assert.ok(!/isPlanMode|emit\(/.test(expose), 'setInputText 不得触碰模式或派发事件');
  // 宿主回填 / 优化草稿 / 听写 / 清空都走同一个程序写入通道，watch 只做形态映射
  const writer = extractFunctionBody(source, 'const writeInputText = ');
  assert.ok(writer.includes('inputText.value = text'), '程序写入通道负责唯一的文本赋值');
  assert.ok(writer.includes('programmaticWrite = true'), '程序写入必须打上标记，供 watch 区分用户输入');

  // 历史缺陷的形态不得复活
  assert.ok(!/rawText\.startsWith\('\/plan '\)/.test(source), '不得恢复「看到 /plan 就改写文本」的老实现');
});

test('快捷指令菜单只看文本形态，不执行命令', () => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  const watchers = extractBlocks(source, 'watch(inputText');
  const menuWatcher = watchers.find(block => block.includes('isCommandMenuOpen')) ?? '';
  assert.ok(menuWatcher !== '', '必须保留「输入 / 唤出快捷指令菜单」的形态映射');
  assert.ok(!/inputText\.value\s*=/.test(menuWatcher), '菜单映射不得改写文本');
});

// ---------- 路径 3：/plan 带正文提交 ----------

test('/plan 带正文提交：模式切到 plan，正文原样保留', async () => {
  const {resolveChatSendDraft} = await loadParser();
  const draft = resolveChatSendDraft('/plan 把这段重构成策略模式', false);
  assert.equal(draft.text, '把这段重构成策略模式', '命令之后的正文必须原样发送');
  assert.equal(draft.requirePlan, true, '/plan 提交必须带 requirePlan');
  assert.equal(draft.command, 'plan', '必须识别出 plan 命令');

  // 当前已是 plan 模式时，普通文本沿用 plan 语义
  assert.deepEqual(resolveChatSendDraft('把这段重构成策略模式', true),
    {text: '把这段重构成策略模式', requirePlan: true, command: null}, 'plan 模式下发普通文本必须沿用 plan 语义');
  assert.deepEqual(resolveChatSendDraft('普通提问', false),
    {text: '普通提问', requirePlan: false, command: null}, 'auto 模式下发普通文本不得带上 requirePlan');
  // 非 plan 命令不是消息：正文留给用户继续编辑
  const agent = resolveChatSendDraft('/agent 用这个', false);
  assert.equal(agent.command, 'agent', '必须识别出 agent 命令');
  assert.equal(agent.text, '用这个', '非 plan 命令的正文必须保留给用户继续编辑');
});

test('submit 解析只认已知命令名，其它以 / 开头的文本照常发送', async () => {
  const {resolveChatCommandInvocation, resolveChatSendDraft} = await loadParser();
  assert.equal(resolveChatCommandInvocation('/帮我修这个bug'), null, '中文正文不是命令');
  assert.equal(resolveChatCommandInvocation('/refactor'), null, '未知英文命令名不得当成命令');
  assert.equal(resolveChatCommandInvocation('/plan把这段'), null, '命令与正文之间必须有分隔');
  assert.deepEqual(resolveChatCommandInvocation('/plan  正文'), {name: 'plan', body: '正文'},
    '多个空白分隔也必须解析出正文');
  assert.deepEqual(resolveChatCommandInvocation('/PLAN 正文'), {name: 'plan', body: '正文'}, '命令名大小写不敏感');
  const draft = resolveChatSendDraft('/帮我修这个bug', false);
  assert.equal(draft.text, '/帮我修这个bug', '未知命令必须原样发送');
  assert.equal(draft.command, null, '未知命令不得被识别成命令');
});

test('handleSend 用同一套解析结果，且 sendMessage 第 2 参来自 draft.requirePlan', () => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  const handleSend = extractFunctionBody(source, 'const handleSend = ');
  assert.ok(handleSend.includes('resolveChatSendDraft(inputText.value, isPlanMode.value)'),
    'submit 必须统一走 resolveChatSendDraft');
  assert.ok(/\bdraft\.requirePlan\b/.test(handleSend), 'requirePlan 语义必须来自解析结果');
  assert.ok(handleSend.includes("draft.command === 'plan'"), '/plan 提交必须切模式');
  assert.ok(handleSend.includes('resolveTextAfterCommandSelect'), '纯命令 token 的清空同样走统一判据');
});

// ---------- 白名单守护：命令名清单不得与菜单 id 漂移 ----------

/**
 * 从源码里取出一个字符串数组字面量的全部元素。
 *
 * @param source 源码
 * @param declaration 数组声明前缀（如 `export const CHAT_COMMAND_NAMES`）
 * @returns 数组元素文本列表
 */
function extractStringArray(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `找不到声明: ${declaration}`);
  // 从 `=` 之后找数组开口：声明里的 `readonly string[]` 自带一对方括号，直接找 `[` 会取到它。
  const assignment = source.indexOf('=', start);
  assert.ok(assignment > start, `声明 ${declaration} 不是赋值形式`);
  const open = source.indexOf('[', assignment);
  const close = source.indexOf(']', open);
  assert.ok(open >= 0 && close > open, `声明 ${declaration} 的数组未闭合`);
  const literals = source.slice(open, close).match(/'([^']*)'/g) ?? [];
  return literals.map(literal => literal.slice(1, -1));
}

/**
 * 取出 `allCommands` 里声明的全部菜单项 id。
 *
 * @param source ChatInputArea.vue 源码
 * @returns 菜单 id 列表（保持声明顺序）
 */
function extractMenuCommandIds(source: string): string[] {
  const start = source.indexOf('const allCommands = computed<CommandItem[]>(() => [');
  assert.ok(start >= 0, '找不到 allCommands 声明');
  const end = source.indexOf('\n]);', start);
  assert.ok(end > start, 'allCommands 数组未闭合');
  const block = source.slice(start, end);
  return [...block.matchAll(/id:\s*'([^']+)'/g)].map(matched => matched[1]!);
}

test('CHAT_COMMAND_NAMES 必须与输入栏菜单 id 集合完全一致（白名单漂移会静默吞命令）', () => {
  const whitelist = extractStringArray(
    readMutantSource(COMMAND_PARSER, mutation, PARSER_MUTATIONS), 'export const CHAT_COMMAND_NAMES');
  const menuIds = extractMenuCommandIds(readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS));

  // 抽取本身必须可靠，否则这条守护会变成永真断言
  assert.ok(whitelist.length >= 10, `白名单抽取异常，仅得到 ${whitelist.length} 项`);
  assert.ok(menuIds.length >= 10, `菜单 id 抽取异常，仅得到 ${menuIds.length} 项`);

  const onlyInWhitelist = whitelist.filter(name => !menuIds.includes(name));
  const onlyInMenu = menuIds.filter(id => !whitelist.includes(id));
  assert.deepEqual(
    {onlyInWhitelist, onlyInMenu},
    {onlyInWhitelist: [] as string[], onlyInMenu: [] as string[]},
    `白名单与菜单 id 漂移：白名单独有 [${onlyInWhitelist.join(', ')}]（菜单缺这些项）；`
    + `菜单独有 [${onlyInMenu.join(', ')}]（白名单缺这些项）—— 漂移会让「解析出命令名 → `
    + 'runUiCommand 找不到菜单项 → 命令 token 被清掉却什么都没发生」成为静默吞字',
  );
  assert.equal(new Set(whitelist).size, whitelist.length, '白名单不得有重复项');
  assert.equal(new Set(menuIds).size, menuIds.length, '菜单 id 不得有重复项');
});

test('命令未命中菜单项时不得清空正文（白名单漂移的运行时兜底）', () => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  const handleSend = extractFunctionBody(source, 'const handleSend = ');
  assert.ok(/if \(!runUiCommand\(draft\.command\)\)/.test(handleSend),
    'runUiCommand 返回 false（菜单里没有该命令）时必须提前返回，保留用户正文');
});

// ---------- plan 模式受控 ----------

test('plan 模式是受控状态：props 进来、updateMode 事件出去，宿主真正消费', () => {
  const inputArea = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  assert.ok(/mode\?: ChatMode/.test(inputArea), '输入组件必须声明受控 mode prop');
  const isPlanMode = extractBlock(inputArea, 'const isPlanMode = computed<boolean>({');
  assert.ok(isPlanMode.includes('props.mode'), '模式读的必须是受控 prop');
  assert.ok(isPlanMode.includes("emit('updateMode', toChatMode(next))"), '模式写必须派发 updateMode');

  const chatView = readMutantSource(CHAT_VIEW, mutation, CHAT_VIEW_MUTATIONS);
  assert.ok(/:mode="chatMode"/.test(chatView), 'ChatView 必须把受控模式传下去');
  assert.ok(/@updateMode="handleUpdateMode"/.test(chatView), 'ChatView 必须真正消费 updateMode');
  assert.ok(/const chatMode = ref<ChatMode>\('auto'\)/.test(chatView), 'ChatView 必须持有唯一事实源');
});

test('既有交互不让步：Backspace 退出、badge 退出、placeholder、plan 语义', () => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  assert.ok(source.includes("e.key === 'Backspace' && isPlanMode.value && isEmpty"), 'Backspace 空输入退出 plan 必须保留');
  assert.ok(source.includes('@click.stop="isPlanMode = false"'), 'badge 点击退出 plan 必须保留');
  assert.ok(source.includes("t('chat.input.placeholderPlan')"), 'plan 态的 placeholder 必须保留');
  assert.ok(source.includes("(e: 'sendMessage', text: string, requirePlan: boolean"), 'sendMessage 第 2 参契约不变');
});

// ---------- 源码切片工具 ----------

/** 从 `{` 开始做括号匹配，返回结束位置（找不到时返回 -1）。 */
function matchBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** 取出某个记号之后的第一段 `{...}` 代码块（含大括号）。 */
function extractBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到标记: ${marker}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `标记后没有代码块: ${marker}`);
  const end = matchBrace(source, open);
  assert.ok(end > open, `代码块未闭合: ${marker}`);
  return source.slice(start, end + 1);
}

/** 取出某个 `const xxx = () => {...}` 的函数体（含大括号）。 */
function extractFunctionBody(source: string, marker: string): string {
  return extractBlock(source, marker);
}

/** 取出所有同名 watch 的代码块。 */
function extractBlocks(source: string, marker: string): string[] {
  const blocks: string[] = [];
  let index = source.indexOf(marker);
  while (index >= 0) {
    const open = source.indexOf('{', index);
    const end = open > 0 ? matchBrace(source, open) : -1;
    blocks.push(end > open ? source.slice(index, end + 1) : source.slice(index, index + 160));
    index = source.indexOf(marker, index + marker.length);
  }
  return blocks;
}
