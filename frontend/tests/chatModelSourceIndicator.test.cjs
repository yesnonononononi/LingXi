/**
 * 配置类展示字段的响应式守卫（2026-10-15 缺陷复盘）。
 *
 * <p><b>缺陷形态</b>：{@code useChatView} 直接把 Pinia setup store 的 ref 读成值返回
 * （{@code selectedAgentId: userConfig.agentId}、{@code accessMode: userConfig.accessMode}）。
 * setup store 的 ref 只在**响应式上下文**里读取才建立依赖，在 setup 顶层直接读拿到的是
 * **取值快照**；而配置是挂载后才异步载入的 ⇒ 快照把「载入前」的 null 永久固化。</p>
 *
 * <p>危害不是「显示旧值」这么轻：请求侧 {@code buildCommand} 在发送时才读 store 的活值，
 * 于是 <b>Agent 明明选中、请求里也带着 agentId，🤖 芯片却永不出现</b>，模型被 Agent 预设
 * 接管（实测跑了 claude-opus-4-7 而选择器显示 deepseek-flash），用户既看不见也清不掉。</p>
 *
 * <p>这里用源码级守卫钉住：这两个字段必须以 computed 形态暴露。行为级复现需要挂载整个
 * ChatView（依赖后端与 pinia 初始化时序），源码级断言足以挡住「改回取一次值」的回退。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const viewSource = fs.readFileSync(
  path.resolve(__dirname, '../src/views/chat/useChatView.ts'),
  'utf8'
);
/**
 * 装配面扫描范围：插入区试点把「模型选择器」整段从 `ChatInputArea.vue` 搬进了
 * `ChatInputModelSelector.vue`（默认实现），因此断言在这两个文件里**任一处**命中即成立 ——
 * 断言条件本身不变，只是让「搬家」不至于把这条护栏变成假红。
 * 选择器里的 `(?:props\.)?` 同理：搬成组件后模板引用的是 props。
 */
const inputSource = [
  '../src/components/chat/ChatInputArea.vue',
  '../src/components/chat/ChatInputModelSelector.vue',
]
  .map((rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8'))
  .join('\n/* --- 下一个文件 --- */\n');

test('金丝雀：两个被测文件都读到了（否则下面的「不得出现」可能假绿）', () => {
  assert.match(viewSource, /export function useChatView/, '未读到 useChatView 源码');
  assert.match(viewSource, /\n  return \{/, '未读到 useChatView 的返回块');
  assert.match(inputSource, /const drivenModel = computed/, '未读到 ChatInputArea 的源文件');
});

test('配置类展示字段以 computed 暴露，不得直接返回 store 的取值快照', () => {
  for (const field of ['selectedAgentId', 'accessMode']) {
    assert.match(
      viewSource,
      new RegExp(`const ${field} = computed\\(`),
      `${field} 必须以 computed 暴露，否则会在 setup 期被固化成 null 快照`
    );
    assert.doesNotMatch(
      viewSource,
      new RegExp(`${field}: userConfig\\.`),
      `${field} 不得直接返回 userConfig 的取值快照（配置载入晚于 setup，会永久停在载入前）`
    );
  }
});

test('Agent/团队驱动时必须显式呈现实际生效模型与来源，而不是只显示全局选择器', () => {
  // 徽标：drivenModel 非空时替换模型下拉（v-if / v-else 成对）
  assert.match(inputSource, /v-if="(?:props\.)?drivenModel"/, '缺少实际生效模型徽标');
  assert.match(inputSource, /v-else\s*\n\s*v-model="selectedModel"/, '徽标必须与模型下拉互斥');
  // 点击徽标要能直达改预设的地方
  assert.match(inputSource, /onOpenSettingsTab\('agents'\)/, '徽标应能跳转「智能体」设置');
  // 两种来源（指挥者 / 单 Agent）都要覆盖
  assert.match(inputSource, /modelSourceCommander/, '未覆盖协作模式（指挥者预设）来源');
  assert.match(inputSource, /modelSourceAgent/, '未覆盖单 Agent 直聊来源');
});
