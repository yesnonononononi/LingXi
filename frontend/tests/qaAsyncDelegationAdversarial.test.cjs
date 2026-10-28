const path = require('node:path');
const { reactive, nextTick } = require('vue');
// 挂载 harness 收敛到 tests/support/chatProcessHarness.cjs：唯一 stub 清单 + 目录递归真实加载。
const harness = require('./support/chatProcessHarness.cjs');
const { find, findAll, text } = harness;

// 协作式委派链路需要 requestAnimationFrame（贴底调度），保持与本套件历史语义一致。
const mountComponent = (t, definition, props) => harness.mountComponent(t, definition, props, { raf: true });

/** 加载 `src/` 下的组件与其工具模块（白名单语义见共享 harness）。 */
const component = relative => harness.loadFromSrc(relative, { compileId: 'qa-async-delegation', restrictToRealPrefixes: true }).default;
const util = relative => harness.loadFromSrc(relative, { compileId: 'qa-async-delegation', restrictToRealPrefixes: true });

/**
 * 交付总监独立验证（QA 严过关）—— AC-5 对抗性用例。
 *
 * <p>锁定工程师用例未覆盖的边界：子会话「等待审批」态、IDLE 态不得被写成完成/失败；
 * 委派等待卡 pending 时不得误报失败；「进行中」时三处都不得出现「执行完成 / 执行失败」。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');

test('AC-5 对抗：子会话 RUNNING 时详情状态栏不得出现「执行完成」也不得出现「执行失败」', async t => {
  const subSession = reactive({ id: '88', agentName: '工程师', runStatus: 'RUNNING' });
  const root = mountComponent(t, component('components/chat/SubSessionDetailDrawer.vue'), {
    isOpen: true, subSession, isDark: true,
  });

  assert.match(text(root), /执行中/);
  assert.doesNotMatch(text(root), /执行完成/, '进行中不得显示完成');
  assert.doesNotMatch(text(root), /执行失败/, '进行中不得显示失败');

  subSession.runStatus = 'SUSPENDED';
  await nextTick();
  assert.match(text(root), /等待审批/, '挂起态应显示等待审批');
  assert.doesNotMatch(text(root), /执行完成/);
  assert.doesNotMatch(text(root), /执行失败/);
});

test('AC-5 对抗：子会话 IDLE 且无 outcome 时也不得显示完成/失败', async t => {
  const subSession = reactive({ id: '90', agentName: '工程师', runStatus: 'IDLE' });
  const root = mountComponent(t, component('components/chat/SubSessionDetailDrawer.vue'), {
    isOpen: true, subSession, isDark: true,
  });

  assert.doesNotMatch(text(root), /执行完成/, 'IDLE 无结果不得臆断为完成');
  assert.doesNotMatch(text(root), /执行失败/, 'IDLE 无结果不得臆断为失败');
});

test('AC-5 对抗：协同条色点——子会话进行中即便工具 calling 也必须是执行中', async t => {
  const { AgentToolName } = util('utils/toolNames.ts');
  const subSessions = reactive([{ id: '77', agentId: '5', agentName: '工程师', runStatus: 'RUNNING' }]);
  const message = reactive({
    id: 'a2', role: 'assistant', turnId: '102', timestamp: 0,
    content: '', isComplete: false,
    toolCalls: [{
      id: 'tc-delegate-2', toolName: AgentToolName.CallSubAgent, status: 'calling',
      query: JSON.stringify({ agentId: 5, agentName: '工程师', task: '写代码', runtime_mode: 'async' }),
      subSessionId: '77', order: 0,
    }],
  });
  const root = mountComponent(t, component('components/chat/ChatMessageItem.vue'), { message, isDark: true, subSessions });

  const segment = find(root, node => node.props?.['data-testid'] === 'process-segment');
  assert.equal(segment.props['data-process-mode'], 'live');
  await nextTick();
  // 新契约：细节默认折叠，先展开摘要行再取成员行。
  const toggle = find(segment, node => node.props?.['data-testid'] === 'process-segment-toggle');
  assert.ok(toggle, '运行态也必须有摘要行');
  toggle.props.onClick();
  await nextTick();
  const member = find(root, node => node.tag === 'button' && String(node.props.title ?? '').startsWith('协作式委派'));
  assert.ok(member, '协作式委派成员行应存在');
  const dot = find(member, node => {
    const cls = String(node.props.class ?? '');
    return cls.includes('w-1.5') && cls.includes('rounded-full');
  });
  assert.ok(dot, '应有状态色点');
  assert.match(dot.props.class, /bg-amber-400/, '子会话进行中 → 琥珀脉冲');
  assert.doesNotMatch(dot.props.class, /bg-emerald-500/);
});

test('AC-5 对抗：isAsyncDelegation 边界（纯结果标记 / 空白 / 缺项）', () => {
  const { isAsyncDelegation } = util('utils/asyncDelegation.ts');
  assert.equal(isAsyncDelegation({ result: JSON.stringify({ runtimeMode: 'ASYNC', delegated: true }) }), true);
  assert.equal(isAsyncDelegation({ query: JSON.stringify({ runtime_mode: '  async  ' }) }), true, '容忍首尾空白');
  assert.equal(isAsyncDelegation({ query: JSON.stringify({ runtime_mode: '' }) }), false);
  assert.equal(isAsyncDelegation({ query: 'not-json', result: '' }), false, '非法 JSON 不得误判为协作式');
});
