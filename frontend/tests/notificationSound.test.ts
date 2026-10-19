import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SOUND_ID,
  SOUND_IDS,
  SOUND_STORAGE_KEY,
  normalizeSoundId,
  playNotificationSound,
  readSoundPreference,
  resetSoundEngine,
  writeSoundPreference,
} from '../src/notification/sound';
import { KNOWN_SOUNDS, normalizePayload } from '../electron/notification-window.cjs';

/* ---------------------------------------------------------------- 测试替身 */

/** 记录假音频栈被调用了什么：用来证明「配方真的被排上了音」而不是悄悄 return。 */
interface AudioCalls {
  contexts: number;
  oscillators: number;
  starts: number;
  resumes: number;
}

/**
 * 装一套最小的 AudioContext 替身。
 *
 * @param state 初始状态；'suspended' 用于验证「新窗口无手势时会被催一次 resume」
 */
function installFakeAudio(state: AudioContextState = 'running'): AudioCalls {
  const calls: AudioCalls = { contexts: 0, oscillators: 0, starts: 0, resumes: 0 };

  class FakeParam {
    value = 0;
    setValueAtTime(): void {}
    linearRampToValueAtTime(): void {}
    exponentialRampToValueAtTime(): void {}
  }
  class FakeNode {
    connect(): this { return this; }
  }
  class FakeOscillator extends FakeNode {
    type = 'sine';
    frequency = new FakeParam();
    start(): void { calls.starts += 1; }
    stop(): void {}
  }
  class FakeGain extends FakeNode {
    gain = new FakeParam();
  }
  class FakeAudioContext {
    currentTime = 0;
    destination = new FakeNode();
    state = state;
    constructor() { calls.contexts += 1; }
    createOscillator(): FakeOscillator { calls.oscillators += 1; return new FakeOscillator(); }
    createGain(): FakeGain { return new FakeGain(); }
    resume(): Promise<void> { calls.resumes += 1; return Promise.resolve(); }
  }

  Reflect.set(globalThis, 'window', { AudioContext: FakeAudioContext });
  resetSoundEngine();
  return calls;
}

/** 清掉替身，回到「纯 node，没有任何浏览器对象」的状态。 */
function clearFakeAudio(): void {
  Reflect.deleteProperty(globalThis, 'window');
  resetSoundEngine();
}

/* ---------------------------------------------------------------- 归一化 */

test('合法 id 原样返回，大小写与首尾空格归一', () => {
  assert.equal(normalizeSoundId('chime'), 'chime');
  assert.equal(normalizeSoundId('BELL'), 'bell');
  assert.equal(normalizeSoundId('  marimba  '), 'marimba');
});

test('垃圾输入一律回落默认音效，不返回 undefined', () => {
  for (const raw of [undefined, null, 123, {}, [], true, '', '   ', '爆炸声']) {
    assert.equal(normalizeSoundId(raw), DEFAULT_SOUND_ID, `输入 ${JSON.stringify(raw)} 应回落默认`);
  }
});

test('none 是合法值，不能被当成「没设置过」改写', () => {
  assert.equal(normalizeSoundId('none'), 'none');
  assert.notEqual(DEFAULT_SOUND_ID, 'none');
});

test('前端音效表与主进程白名单必须完全一致', () => {
  // 少一项的表现是「设置里能选、真通知不出声」，靠人眼盯必然漏
  assert.equal(SOUND_IDS.length, KNOWN_SOUNDS.length);
  for (const id of SOUND_IDS) assert.ok(KNOWN_SOUNDS.includes(id), `主进程缺少音效 ${id}`);
  for (const id of KNOWN_SOUNDS) assert.ok((SOUND_IDS as readonly string[]).includes(id), `前端缺少音效 ${id}`);
});

/* ---------------------------------------------------------------- 请求归一化 */

test('payload 只放行白名单内的音效，其余置空', () => {
  assert.equal(normalizePayload({ sound: 'bell' }).sound, 'bell');
  assert.equal(normalizePayload({ sound: 'explode' }).sound, null);
  assert.equal(normalizePayload({ sound: 42 }).sound, null);
  // 不传音效 = 这条通知不出声，不能被补成默认值
  assert.equal(normalizePayload({}).sound, null);
});

/* ---------------------------------------------------------------- 播放 */

test('选静音时不构造 AudioContext，直接静默', () => {
  const calls = installFakeAudio();
  try {
    assert.equal(playNotificationSound('none'), false);
    assert.equal(calls.contexts, 0);
  } finally {
    clearFakeAudio();
  }
});

test('没有 AudioContext 的环境返回 false 且不抛', () => {
  clearFakeAudio();
  assert.equal(playNotificationSound('chime'), false);
});

test('AudioContext 被策略挂起时先 resume 一次', () => {
  const calls = installFakeAudio('suspended');
  try {
    assert.equal(playNotificationSound('pop'), true);
    assert.equal(calls.resumes, 1);
  } finally {
    clearFakeAudio();
  }
});

test('每个音效都按配方段数排音（三种音效段数各不相同）', () => {
  const expected: Record<string, number> = { chime: 2, marimba: 3, bell: 3, pop: 1 };
  for (const [id, segments] of Object.entries(expected)) {
    const calls = installFakeAudio();
    try {
      assert.equal(playNotificationSound(id as 'chime'), true, `${id} 应返回 true`);
      assert.equal(calls.starts, segments, `${id} 应排 ${segments} 段音`);
      assert.equal(calls.contexts, 1, `${id} 只应新建一次 AudioContext`);
    } finally {
      clearFakeAudio();
    }
  }
});

test('AudioContext 在多次播放间复用，不重复创建', () => {
  const calls = installFakeAudio();
  try {
    playNotificationSound('chime');
    playNotificationSound('bell');
    assert.equal(calls.contexts, 1);
  } finally {
    clearFakeAudio();
  }
});

/* ---------------------------------------------------------------- 偏好 */

test('偏好读写回环，损坏值回落默认', () => {
  const store = new Map<string, string>();
  Reflect.set(globalThis, 'localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  });
  try {
    writeSoundPreference('bell');
    assert.equal(store.get(SOUND_STORAGE_KEY), 'bell');
    assert.equal(readSoundPreference(), 'bell');

    writeSoundPreference('none');
    assert.equal(readSoundPreference(), 'none');

    // 存储里被塞了脏值（旧版本、手工改过）：读出来必须是合法 id
    store.set(SOUND_STORAGE_KEY, '爆炸声');
    assert.equal(readSoundPreference(), DEFAULT_SOUND_ID);
  } finally {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('没有 localStorage 时读偏好回落默认，不抛', () => {
  Reflect.deleteProperty(globalThis, 'localStorage');
  assert.equal(readSoundPreference(), DEFAULT_SOUND_ID);
  // 写不进去也不能打断设置流程
  writeSoundPreference('chime');
});
