const path = require('node:path');
const { reactive, nextTick } = require('vue');
// 挂载 harness 收敛到 tests/support/chatProcessHarness.cjs：唯一 stub 清单 + 目录递归真实加载。
const harness = require('./support/chatProcessHarness.cjs');
const { find, findAll, text } = harness;

// 协作式委派链路需要 requestAnimationFrame（贴底调度），保持与本套件历史语义一致。
const mountComponent = (t, definition, props) => harness.mountComponent(t, definition, props, { raf: true });

/** 加载 `src/` 下的组件与其工具模块（白名单语义见共享 harness）。 */
const component = relative => harness.loadFromSrc(relative, { compileId: 'async-delegation', restrictToRealPrefixes: true }).default;
const util = relative => harness.loadFromSrc(relative, { compileId: 'async-delegation', restrictToRealPrefixes: true });

/**
 * 协作式（异步）委派展示态的组件层回归（AC-5）。
 *
 * <p>编译真实 .vue / .ts，仅替换浏览器依赖（Transition / Teleport）、主题与网络服务，
 * 组件自身逻辑原样执行。锁定三个「仍在跑却被显示成已完成 / 已失败」的误判点：
 * ① 协同条成员色点；② 子会话详情状态栏；③ 委派等待卡结论。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');

test('asyncDelegation：isAsyncDelegation 从入参 runtime_mode 或结果 runtimeMode 判定', () => {
  const { isAsyncDelegation } = util('utils/asyncDelegation.ts');
  assert.equal(isAsyncDelegation({ query: JSON.stringify({ runtime_mode: 'async' }) }), true, '入参 runtime_mode=async');
  assert.equal(isAsyncDelegation({ query: JSON.stringify({ runtime_mode: 'ASYNC' }) }), true, '大小写不敏感');
  assert.equal(isAsyncDelegation({ result: JSON.stringify({ runtimeMode: 'ASYNC' }) }), true, '结果 runtimeMode=ASYNC');
  assert.equal(isAsyncDelegation({ query: JSON.stringify({ runtime_mode: 'blocking' }) }), false, 'blocking 不是协作式');
  assert.equal(isAsyncDelegation({ query: '{}', result: '{}' }), false, '缺省即阻塞式');
  assert.equal(isAsyncDelegation(undefined), false);
  assert.equal(isAsyncDelegation(null), false);
});

test('asyncDelegation：asyncSubSessionStatus 优先子会话权威态，缺省才回落工具态', () => {
  const { asyncSubSessionStatus } = util('utils/asyncDelegation.ts');
  // 工具已 success，但子会话仍在跑 —— 必须以子会话权威态为准。
  assert.equal(asyncSubSessionStatus({ runStatus: 'RUNNING' }, { status: 'success' }), 'running');
  assert.equal(asyncSubSessionStatus({ runStatus: 'IDLE', lastOutcome: 'COMPLETED' }, { status: 'calling' }), 'completed');
  assert.equal(asyncSubSessionStatus({ runStatus: 'IDLE', lastOutcome: 'FAILED' }, { status: 'success' }), 'failed');
  assert.equal(asyncSubSessionStatus({ runStatus: 'SUSPENDED' }, { status: 'success' }), 'suspended');
  // 无子会话（未经子会话渲染）才允许回落工具调用状态。
  assert.equal(asyncSubSessionStatus(undefined, { status: 'calling' }), 'running');
  assert.equal(asyncSubSessionStatus(undefined, { status: 'success' }), 'completed');
  assert.equal(asyncSubSessionStatus(undefined, { status: 'failed' }), 'failed');
});

test('asyncDelegation：状态点色与文案映射稳定', () => {
  const { subItemStatusDotClass, subItemStatusLabel } = util('utils/asyncDelegation.ts');
  assert.equal(subItemStatusDotClass('running'), 'bg-amber-400 lx-live-dot');
  assert.equal(subItemStatusDotClass('completed'), 'bg-emerald-500');
  assert.equal(subItemStatusDotClass('failed'), 'bg-red-500');
  assert.equal(subItemStatusDotClass('cancelled'), 'bg-zinc-400');
  assert.equal(subItemStatusLabel('running'), '执行中');
  assert.equal(subItemStatusLabel('completed'), '执行完成');
  assert.equal(subItemStatusLabel('failed'), '执行失败');
  assert.equal(subItemStatusLabel('cancelled'), '已取消');
});

test('AC-5 协同条成员色点：协作式委派下由子会话权威态驱动，不被工具 success 误判为完成', async t => {
  const { AgentToolName } = util('utils/toolNames.ts');
  const subSessions = reactive([{ id: '88', agentId: '5', agentName: '工程师', runStatus: 'RUNNING' }]);
  const message = reactive({
    id: 'a1', role: 'assistant', turnId: '101', timestamp: 0,
    content: '', isComplete: false,
    toolCalls: [{
      id: 'tc-delegate', toolName: AgentToolName.CallSubAgent, status: 'success',
      query: JSON.stringify({ agentId: 5, agentName: '工程师', task: '写代码', runtime_mode: 'async' }),
      subSessionId: '88', order: 0,
    }],
  });
  const root = mountComponent(t, component('components/chat/ChatMessageItem.vue'), { message, isDark: true, subSessions });

  const segment = find(root, node => node.props?.['data-testid'] === 'process-segment');
  assert.equal(segment.props['data-process-mode'], 'live');
  await nextTick();
  // 新契约：运行态细节默认折叠，成员行在展开后可见（摘要行始终存在）。
  const toggle = find(segment, node => node.props?.['data-testid'] === 'process-segment-toggle');
  assert.ok(toggle, '运行态也必须有摘要行');
  toggle.props.onClick();
  await nextTick();
  const member = find(root, node => node.tag === 'button' && String(node.props.title ?? '').startsWith('协作式委派'));
  assert.ok(member, '协作式委派成员行必须带「结果将以邮件送达」提示');
  assert.match(String(member.props.title), /邮件/);
  const resolveDot = () => find(member, node => {
    const cls = String(node.props.class ?? '');
    return cls.includes('w-1.5') && cls.includes('rounded-full');
  });
  const dot = resolveDot();
  assert.ok(dot, '成员行必须有状态色点');
  assert.match(dot.props.class, /bg-amber-400/, '工具已 success 但子会话仍在跑 → 色点必须是执行中');
  assert.doesNotMatch(dot.props.class, /bg-emerald-500/);

  subSessions[0].runStatus = 'IDLE';
  subSessions[0].lastOutcome = 'COMPLETED';
  await nextTick();
  assert.match(resolveDot().props.class, /bg-emerald-500/, '子会话完成后色点才可以是完成色');

  subSessions[0].lastOutcome = 'FAILED';
  await nextTick();
  assert.match(resolveDot().props.class, /bg-red-500/, '子会话失败时色点必须是失败色');
});

test('AC-5 子会话详情状态栏：不再硬编码「执行完成」，由权威态驱动', async t => {
  const subSession = reactive({ id: '88', agentName: '工程师', runStatus: 'RUNNING' });
  const root = mountComponent(t, component('components/chat/SubSessionDetailDrawer.vue'), {
    isOpen: true, subSession, isDark: true,
  });

  assert.match(text(root), /执行中/, '子会话仍在跑必须显示执行中');
  assert.doesNotMatch(text(root), /执行完成/, '不得写死「执行完成」');

  subSession.runStatus = 'IDLE';
  subSession.lastOutcome = 'COMPLETED';
  await nextTick();
  assert.match(text(root), /执行完成/, '子会话结束后才显示完成');

  subSession.lastOutcome = 'FAILED';
  await nextTick();
  assert.match(text(root), /执行失败/, '子会话失败按权威态显示失败');
  assert.doesNotMatch(text(root), /执行完成/);
});

test('asyncDelegation：协作式子会话未出现 → 进行中（不回落 success）；阻塞式 success → 完成', () => {
  const { asyncSubSessionStatus } = util('utils/asyncDelegation.ts');
  // 协作式：工具已立即 success，但子代理定义上仍在跑 —— 子会话未出现时必须判「进行中」。
  const asyncByArgs = { status: 'success', query: JSON.stringify({ agentId: 5, task: '写代码', runtime_mode: 'async' }) };
  const asyncByResult = { status: 'success', result: JSON.stringify({ runtimeMode: 'ASYNC' }) };
  assert.equal(asyncSubSessionStatus(undefined, asyncByArgs), 'running', '协作式 + 未发现子会话 → 进行中');
  assert.notEqual(asyncSubSessionStatus(undefined, asyncByArgs), 'completed', '不得抢先判完成');
  assert.equal(asyncSubSessionStatus(undefined, asyncByResult), 'running', '结果带 runtimeMode=ASYNC 同样判进行中');
  // 对照：阻塞式（无 runtime_mode / runtimeMode）仍按工具态回落，success 等价子代理真的跑完了。
  const blocking = { status: 'success', query: JSON.stringify({ agentId: 5, task: '写代码' }) };
  assert.equal(asyncSubSessionStatus(undefined, blocking), 'completed', '阻塞式 success 仍按完成');
  assert.equal(asyncSubSessionStatus(undefined, { status: 'calling' }), 'running');
  assert.equal(asyncSubSessionStatus(undefined, { status: 'failed' }), 'failed');
});

test('AC-5 协作式委派：子会话尚未出现时不得抢先亮「完成」，须为进行中', async t => {
  const { AgentToolName } = util('utils/toolNames.ts');
  const message = reactive({
    id: 'a-pending', role: 'assistant', turnId: '102', timestamp: 0,
    content: '', isComplete: false,
    toolCalls: [{
      id: 'tc-delegate-pending', toolName: AgentToolName.CallSubAgent, status: 'success',
      query: JSON.stringify({ agentId: 5, agentName: '工程师', task: '写代码', runtime_mode: 'async' }),
      subSessionId: '99', order: 0,
    }],
  });
  // 第一条实时事件到达前：props.subSessions 里还没有这个子会话。
  const subSessions = reactive([]);
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
  assert.ok(member, '协作式委派成员行必须渲染');
  const dot = find(member, node => {
    const cls = String(node.props.class ?? '');
    return cls.includes('w-1.5') && cls.includes('rounded-full');
  });
  assert.ok(dot, '成员行必须有状态色点');
  assert.match(dot.props.class, /bg-amber-400/, '子会话未出现时协作式必须显示执行中');
  assert.doesNotMatch(dot.props.class, /bg-emerald-500/, '不得抢先亮完成');
});

test('asyncDelegation：协作式 + 无子会话 + 工具失败 → 如实回落 failed（不抑制）', () => {
  const { asyncSubSessionStatus } = util('utils/asyncDelegation.ts');
  const failed = { status: 'failed', query: JSON.stringify({ agentId: 5, task: '写代码', runtime_mode: 'async' }) };
  assert.equal(asyncSubSessionStatus(undefined, failed), 'failed', '提交被拒（工具 err）时子会话永不出现，必须如实判失败');
  assert.notEqual(asyncSubSessionStatus(undefined, failed), 'running', '不得再无条件判进行中');
});

test('asyncDelegation：协作式 + 无子会话 + 工具进行中 → 保持 running', () => {
  const { asyncSubSessionStatus } = util('utils/asyncDelegation.ts');
  const calling = { status: 'calling', result: JSON.stringify({ runtimeMode: 'ASYNC' }) };
  assert.equal(asyncSubSessionStatus(undefined, calling), 'running', '协作式未落地且工具仍在调用 → 进行中');
});

test('asyncDelegation：对照——阻塞式 + success 仍判完成（回落未被误删）', () => {
  const { asyncSubSessionStatus } = util('utils/asyncDelegation.ts');
  const blocking = { status: 'success', query: JSON.stringify({ agentId: 5, task: '写代码' }) };
  assert.equal(asyncSubSessionStatus(undefined, blocking), 'completed', '阻塞式 success 等价子代理跑完');
});
