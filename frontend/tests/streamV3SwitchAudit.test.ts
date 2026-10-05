import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { useChatView } from '../src/views/chat/useChatView';
import { chatApi } from '../src/services/chat';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { createHarness, flush, frame, readyFrame, bootstrapSnapshot, promiseCard } from './harness/streamV3Harness';

// 审查专用：调用生产组合函数与 SSE 接线，只替换网络边界。
function setupAudit() {
  const harness = createHarness();
  const scope = effectScope();
  const view = scope.run(() => useChatView({}, (() => undefined) as any))!;
  const store = useStreamV3Store();
  const originals = {
    detail: chatApi.fetchSessionDetail,
    models: chatApi.fetchModels,
    configs: chatApi.fetchUserConfigs,
    command: chatApi.sendCommand,
  };
  const buildRows = (id: string) => [
    { id: `${id}1`, sessionId: id, turnId: `${id}-t1`, type: 'USER', text: `${id}提问` },
    { id: `${id}2`, sessionId: id, turnId: `${id}-t1`, type: 'AI', text: `${id}已提交回答` },
  ];
  view.localSessions.value = ['100', '300'].map(id => ({
    id, title: id, createdAt: 0, updatedAt: 0, messages: [], runStatus: 'IDLE',
  })) as any;
  (chatApi as any).fetchSessionDetail = async (id: string) => ({ ok: true, data: {
    id, title: id, rawRecords: buildRows(id), turns: {}, subSessions: [],
    runStatus: 'IDLE', hasMoreMessages: false, nextMessageCursor: null,
  } });
  (chatApi as any).fetchModels = async () => ({ ok: true, data: [] });
  (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });
  async function enter(id: string, overrides: any = {}) {
    await view.handleSelectSession(id);
    await flush();
    harness.server.push(id, readyFrame(`ready-${id}`));
    await flush();
    assert.ok(harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: id, historyRevision: '1', sessions: [{ id } as any],
      history: { records: buildRows(id), turns: {}, hasMore: false, nextCursor: null },
      ...overrides,
    })));
    await flush();
    assert.equal(store.getPhase(id), 'live');
  }
  return { harness, view, store, enter, cleanup() {
    scope.stop();
    harness.teardown();
    chatApi.fetchSessionDetail = originals.detail;
    chatApi.fetchModels = originals.models;
    chatApi.fetchUserConfigs = originals.configs;
    chatApi.sendCommand = originals.command;
  } };
}

test('核验：正常 A→B→A 后持久化正文恢复，后续 SSE 继续渲染', async () => {
  const a = setupAudit();
  try {
    await a.enter('100');
    await a.enter('300');
    await a.enter('100');
    a.harness.server.push('100', frame('TEXT_DELTA', {streamKey:'switch-live', delta:'切回后的正文'},
      {sessionId:'100', turnId:'100-t1', executionId:'e1'}));
    await flush();
    assert.ok(a.view.displayedMessages.value.some(m => m.content.includes('100已提交回答')));
    assert.ok(a.view.displayedMessages.value.some(m => m.content.includes('切回后的正文')));
    assert.equal(a.harness.server.openCount('100'), 2);
  } finally { a.cleanup(); }
});

test('核验：新轮次只有用户落库行时 delta 应立即出现在回答气泡', async () => {
  const a = setupAudit();
  try {
    await a.enter('100');
    a.harness.server.push('100', frame('MESSAGE_COMMITTED', {
      messageId:'1003',sessionId:'100',turnId:'100-t2',type:'USER',text:'第二轮提问',
    }), frame('RESPONSE_STARTED', {streamKey:'new-turn'}, {sessionId:'100',turnId:'100-t2',executionId:'e2'}),
      frame('TEXT_DELTA', {streamKey:'new-turn',delta:'第二轮增量'}, {sessionId:'100',turnId:'100-t2',executionId:'e2'}));
    await flush();
    assert.equal(a.store.getResponse('new-turn')?.text,'第二轮增量');
    assert.ok(a.view.displayedMessages.value.some(m=>m.content==='第二轮提问'));
    assert.ok(a.view.displayedMessages.value.some(m=>m.content.includes('第二轮增量')),
      'delta 已进入状态源，但新轮次没有 assistant 宿主，正文未显示');
  } finally { a.cleanup(); }
});

test('核验：A 命令回执迟到不得关闭当前 B 的 SSE', async () => {
  const a = setupAudit();
  try {
    await a.enter('100');
    await a.view.handleModelUpdated();
    let release!: (value: any) => void;
    (chatApi as any).sendCommand = () => new Promise(resolve => { release = resolve; });
    const sending = a.view.handleSendMessage('新提问', false, false, false);
    await a.enter('300');
    release({ sessionId:'100', turnId:'100-t2', executionId:'e2' });
    await sending;
    await flush();
    assert.equal(a.view.currentActiveSession.value?.id, '300');
    assert.ok(a.harness.server.connection('300'), '迟到回执关闭了正在查看的 B 连接');
  } finally { a.cleanup(); }
});

test('核验：迟到的重发回执不得抹掉新代际已经提交的正文', async () => {
  const a = setupAudit();
  try {
    await a.enter('100');
    await a.view.handleModelUpdated();
    let release!: (value: any) => void;
    (chatApi as any).sendCommand = () => new Promise(resolve=>{release=resolve;});
    const resending=a.view.handleResendMessage({id:'1001',role:'user',content:'100提问'} as any);
    a.harness.server.push('100', frame('HISTORY_INVALIDATED', {rootSessionId:'100',historyRevision:'2'}),
      frame('MESSAGE_COMMITTED', {messageId:'1003',sessionId:'100',turnId:'100-t2',type:'USER',text:'重发提问'}),
      frame('MESSAGE_COMMITTED', {messageId:'1004',sessionId:'100',turnId:'100-t2',type:'AI',text:'重发后的正文',streamKey:'resend-live'},
        {sessionId:'100',turnId:'100-t2',executionId:'e2'}));
    await flush();
    assert.ok(a.view.displayedMessages.value.some(m=>m.content.includes('重发后的正文')));
    release({sessionId:'100',turnId:'100-t2',executionId:'e2',invalidatedTurnIds:['100-t1'],invalidatedExecutionIds:['e1']});
    await resending;
    await flush();
    assert.ok(a.view.displayedMessages.value.some(m=>m.content.includes('重发后的正文')));
  } finally { a.cleanup(); }
});

test('核验：切走期间已决断的卡片切回后不得仍显示待审批', async () => {
  const a = setupAudit();
  try {
    await a.enter('100');
    a.harness.server.push('100', frame('TOOL_CALL_UPDATED', promiseCard({id:'card-switch',executionId:'e1'})));
    await flush();
    assert.ok(a.view.displayedMessages.value.flatMap(m=>m.promptCards??[]).some(c=>c.toolCallId==='card-switch'&&c.pending));
    await a.enter('300');
    // 卡片在另一客户端完成决策；切回快照完整的未决卡片集合为空。
    const decided=promiseCard({id:'card-switch',executionId:'e1',version:'2',pending:false,
      status:'completed',allowedActions:[],rawOutput:{outcome:'APPROVED'}});
    await a.enter('100', {toolCalls:[],history:{records:[
      {id:'1001',sessionId:'100',turnId:'100-t1',type:'USER',text:'100提问'},
      {id:'1002',sessionId:'100',turnId:'100-t1',type:'AI',text:'100已提交回答'},
      {id:'1005',sessionId:'100',turnId:'100-t1',type:'TOOL',toolCallId:'card-switch',toolCall:decided},
    ],turns:{},hasMore:false,nextCursor:null}});
    assert.equal(a.view.displayedMessages.value.flatMap(m=>m.promptCards??[])
      .filter(c=>c.toolCallId==='card-switch'&&c.pending).length, 0, '旧 tools 槽让已决断卡片继续悬挂');
  } finally { a.cleanup(); }
});

test('核验：服务端断流后自动重连必须重新 bootstrap 并继续渲染', async () => {
  const a=setupAudit();
  const originalTimer=window.setTimeout;
  try {
    await a.enter('100');
    const scheduled:Array<()=>void>=[];
    window.setTimeout=((callback:()=>void,delay:number)=>{
      if(delay>=1000){scheduled.push(callback);return -1;}
      return originalTimer(callback,delay);
    }) as any;
    a.harness.server.closeFromServer('100');
    await flush();
    assert.equal(scheduled.length,1,'断流应登记重连');
    scheduled[0]!();
    await flush();
    assert.equal(a.harness.server.openCount('100'),2,'应真正建立第二条连接');
    a.harness.server.push('100',readyFrame('reconnected-100'));
    await flush();
    assert.equal(a.harness.bootstrap.calls.length,2,'新连接 READY 必须重新 bootstrap，不能沿用上一条连接的 bootstrapSent');
    a.harness.bootstrap.resolveNext(bootstrapSnapshot({rootSessionId:'100',historyRevision:'1'}));
    await flush();
    assert.equal(a.store.getPhase('100'),'live');
  } finally {
    window.setTimeout=originalTimer;
    a.cleanup();
  }
});

test('核验：无宿主卡片仅凭 SSE 展示，重复更新不新增卡片', async () => {
  const a = setupAudit();
  try {
    await a.enter('100');
    a.harness.server.push('100', frame('TOOL_CALL_UPDATED', promiseCard({id:'card-orphan',
      content:{kind:'PLAN',title:'计划',text:'计划正文'}})));
    await flush();
    const readCards=()=>a.view.displayedMessages.value.flatMap(m=>m.promptCards??[]).filter(c=>c.toolCallId==='card-orphan');
    assert.equal(readCards().length,1);
    assert.equal(readCards()[0].content,'计划正文');
    a.harness.server.push('100', frame('TOOL_CALL_UPDATED', promiseCard({id:'card-orphan',version:'2',
      pending:false,status:'completed',allowedActions:[],content:{kind:'PLAN',title:'计划',text:'计划正文'},
      rawOutput:{outcome:'APPROVED'}})));
    await flush();
    assert.equal(readCards().length,1);
    assert.equal(readCards()[0].pending,false);
  } finally { a.cleanup(); }
});
