import test from 'node:test';
import assert from 'node:assert/strict';
import {computed, ref} from 'vue';
import {chatApi} from '../src/services/chat';
import {useChatSubSession} from '../src/views/chat/useChatSubSession';
import {StreamSessionRouter} from '../src/views/chat/streamSessionRouter';

/**
 * 缺陷：子会话已经进入终态，面板顶部写着「完成」，消息组尾工具条却仍然写着「执行中」。
 *
 * <p>根因：会话级生命周期事件只带来 {@code runStatus} / {@code lastOutcome}，而组尾工具条读的是
 * 轮次摘要（{@code turns[].status}）—— 它只由历史接口下发。终态之后不回查，摘要就停在 RUNNING；
 * 再叠加子会话分页缓存（判据只看消息数组与历史版本，不看轮次摘要），下次点开也拿不到新的。</p>
 *
 * <p>守两条：①终态（完成 / 失败 / 取消）必须触发权威回查，挂起不算终态；②缓存必须随之作废。</p>
 */

type PageResult = Awaited<ReturnType<typeof chatApi.fetchSessionMessages>>;

function completedPage(turnStatus: 'RUNNING' | 'COMPLETED'): PageResult {
  return {
    ok: true,
    data: {
      records: [],
      messages: [],
      turns: {'900': {turnId: '900', status: turnStatus} as any},
      turnViews: {'900': {
        sessionId: 'sub-1', turnId: '900', status: turnStatus, viewVersion: 1,
        blocks: [{blockId: 'text:1', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '交付正文'}],
      } as any},
      nextCursor: null,
      hasMore: false,
    },
  } as PageResult;
}

function harness() {
  const session = ref<any>({
    id: 'root-1',
    messages: [],
    subSessions: [{id: 'sub-1', agentName: '严过关', runStatus: 'IDLE', lastOutcome: 'COMPLETED', messages: []}],
  });
  const sub = useChatSubSession({currentActiveSession: computed(() => session.value)});
  return {session, sub};
}

function terminalEvent(type: string) {
  return {type, metaData: {sessionId: 'sub-1', rootSessionId: 'root-1'}} as any;
}

test('契约：子会话完成 / 失败 / 取消都触发权威回查，挂起不算终态', () => {
  const terminated: string[] = [];
  const router = new StreamSessionRouter({onSubSessionTerminated: id => terminated.push(id)});
  const session: any = {
    id: 'root-1', messages: [],
    subSessions: [{id: 'sub-1', name: '严过关', runStatus: 'RUNNING', messages: []}],
  };
  router.bindRootSession(session);

  router.dispatch(terminalEvent('EXECUTION_COMPLETED'));
  assert.deepEqual(terminated, ['sub-1'], '完成必须触发回查');
  assert.equal(session.subSessions[0].runStatus, 'IDLE');
  assert.equal(session.subSessions[0].lastOutcome, 'COMPLETED');

  router.dispatch(terminalEvent('EXECUTION_SUSPENDED'));
  assert.deepEqual(terminated, ['sub-1'], '挂起不是终态：此刻还没有交付可读');
  assert.equal(session.subSessions[0].runStatus, 'SUSPENDED');

  router.dispatch(terminalEvent('EXECUTION_FAILED'));
  assert.equal(session.subSessions[0].lastOutcome, 'FAILED');

  router.dispatch(terminalEvent('EXECUTION_CANCELLED'));
  assert.equal(session.subSessions[0].lastOutcome, 'CANCELLED', '取消同样要落到终态，否则永远显示执行中');
  assert.deepEqual(terminated, ['sub-1', 'sub-1', 'sub-1']);
});

test('契约：正在查看的子会话终态后立刻回查到终态轮次', async t => {
  let pages = 0;
  t.mock.method(chatApi, 'fetchSessionMessages', async () => {
    pages += 1;
    // 首次（运行中）与终态后回查拿到不同状态的权威摘要。
    return completedPage(pages === 1 ? 'RUNNING' : 'COMPLETED');
  });
  const {sub} = harness();
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(pages, 1);
  assert.equal(sub.activeViewingSubSessionVO.value?.turns?.['900']?.status, 'RUNNING');

  await sub.handleSubSessionTerminated('sub-1');

  assert.equal(pages, 2, '正在查看的子会话终态后必须立刻回查');
  assert.equal(sub.activeViewingSubSessionVO.value?.turns?.['900']?.status, 'COMPLETED',
    '组尾工具条读的是轮次摘要，必须刷新成终态');
});

test('契约：未查看的子会话终态作废缓存，下次点开重拉权威摘要（不额外发请求）', async t => {
  const fetch = t.mock.method(chatApi, 'fetchSessionMessages', async () => completedPage('RUNNING'));
  const {sub} = harness();
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(fetch.mock.callCount(), 1);

  // 切走后终态：只作废缓存，不为所有子会话各发一次请求。
  await sub.handleSelectSubSessionOption(null);
  await sub.handleSubSessionTerminated('sub-1');
  assert.equal(fetch.mock.callCount(), 1, '未查看的子会话不该在终态瞬间发请求');

  // 再次点开：缓存已作废 → 必须重拉，不能被「消息数组没变」的判据挡住。
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(fetch.mock.callCount(), 2, '终态作废的缓存不能让过期轮次摘要继续生效');
});
