import { defineStore } from 'pinia';
import { ref } from 'vue';
import { ApplicationEventStream } from '../services/applicationEventStream';
import { SessionAPI } from '../services/session';
import type { SessionVO } from '../types/chat';
import { isOk } from '../utils/api';

export function mergeSessionState(states: Map<string, SessionVO>, session: SessionVO): void {
  const id = String(session.id);
  const previous = states.get(id);
  if (previous && BigInt(previous.version) >= BigInt(session.version)) return;

  states.set(id, session);
}

/** 只缓存权威元数据，消息仍由会话流维护。 */
export const useApplicationSessionStore = defineStore('applicationSessions', () => {
  const states = ref(new Map<string, SessionVO>());
  const error = ref('');
  let generation = 0;
  let active = false;
  const deleted = new Set<string>();
  const stream = new ApplicationEventStream(event => {
    if (event.event === 'APPLICATION_READY') void synchronize();
    if (event.event === 'SESSION_STATE' && event.data) accept(event.data as SessionVO);
  });

  function accept(session: SessionVO): void {
    if (deleted.has(String(session.id))) return;

    mergeSessionState(states.value, session);
  }

  function forget(id: string): void {
    deleted.add(id);
    states.value.delete(id);
  }

  async function synchronize(): Promise<void> {
    const current = ++generation;
    error.value = '';

    try {
      const result = await SessionAPI.applicationStates();
      if (!active || current !== generation) return;
      if (!isOk(result.code) || !result.data) throw new Error(result.errMsg || '同步会话状态失败');

      result.data.forEach(accept);
    } catch (cause) {
      if (!active || current !== generation) return;

      error.value = '会话状态同步失败';
      console.warn('同步会话状态失败:', cause);
      // 同步失败必须重新走就绪握手，不能把缺失的状态当成同步成功。
      stream.reconnect();
    }
  }

  function start(): void {
    active = true;
    stream.start();
  }

  function close(): void {
    active = false;
    generation++;
    stream.close();
  }

  return { states, error, accept, forget, start, close };
});
