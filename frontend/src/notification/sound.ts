/**
 * 通知提示音：合成配方 + 偏好读写。
 *
 * <p><b>为什么合成而不是加载音频文件：</b>打包态通知窗口跑在 `file://` 源上，相对资源路径
 * 是最容易翻车的一环；而配方是纯数据，测试能盯住。</p>
 *
 * <p><b>为什么不用 Windows 自带 wav：</b>那需要主进程读注册表 + 新增 IPC 通道传音频字节，
 * 且只在 Windows 成立。成本相当，此处选零依赖的一条。</p>
 *
 * <p>本模块同时被主应用与通知窗口两个入口使用，因此不引 Vue、**绝不抛异常** ——
 * 通知链路上一个漏网异常就会把整条提醒断掉，声音不值得成为单点。</p>
 */

/** 可选的提示音；`none` 表示用户主动静音，与「没设置过」不是一回事。 */
export const SOUND_IDS = ['none', 'chime', 'marimba', 'bell', 'pop'] as const;

export type SoundId = (typeof SOUND_IDS)[number];

/** 默认音效：温和的双音，第一次响起来不至于把人吓一跳。 */
export const DEFAULT_SOUND_ID: SoundId = 'chime';

/** 偏好存储键；与 `lingxi-theme` 同属「这台机器的听感/观感」，不进后端配置。 */
export const SOUND_STORAGE_KEY = 'lingxi-notify-sound';

/** 主音量。提示音是提醒不是报警，别把戴耳机的用户送走。 */
const MASTER_GAIN = 0.35;

/** 一段音：多段按 {@link startMs} 排期叠成一条提示音。 */
interface Tone {
  /** 起始频率（Hz） */
  freq: number;
  /** 终止频率（Hz），给扫频用；缺省即等频 */
  endFreq?: number;
  /** 相对整条音效开始的延迟（毫秒） */
  startMs: number;
  durationMs: number;
  type: OscillatorType;
  /** 该段增益，最终还要乘 {@link MASTER_GAIN} */
  gain: number;
}

/**
 * 音效配方表。
 *
 * <p>响度已经在 {@link MASTER_GAIN} 上统一收过，这里只调「音色关系」，不要再逐段改总音量。</p>
 */
const RECIPES: Record<Exclude<SoundId, 'none'>, readonly Tone[]> = {
  // 三角波双音、间隔 90ms：最接近人们对「叮咚」的预期
  chime: [
    { freq: 1318.51, startMs: 0, durationMs: 250, type: 'triangle', gain: 0.9 },
    { freq: 1760, startMs: 90, durationMs: 300, type: 'triangle', gain: 0.75 },
  ],
  // 正弦三连上行：轻快、不刺耳
  marimba: [
    { freq: 523.25, startMs: 0, durationMs: 180, type: 'sine', gain: 1 },
    { freq: 659.25, startMs: 70, durationMs: 180, type: 'sine', gain: 0.85 },
    { freq: 783.99, startMs: 140, durationMs: 220, type: 'sine', gain: 0.7 },
  ],
  // A4 叠两个泛音、长衰减：沉稳，适合长任务
  bell: [
    { freq: 440, startMs: 0, durationMs: 900, type: 'sine', gain: 1 },
    { freq: 880, startMs: 0, durationMs: 700, type: 'sine', gain: 0.35 },
    { freq: 1320, startMs: 0, durationMs: 500, type: 'sine', gain: 0.18 },
  ],
  // 快速下滑的短音：几乎不打断人
  pop: [
    { freq: 900, endFreq: 300, startMs: 0, durationMs: 70, type: 'sine', gain: 1 },
  ],
};

/**
 * 归一化音效 id。
 *
 * @param raw 任意来源的值（存储、IPC、旧版本残留）
 * @returns 合法 id；其余一律回落 {@link DEFAULT_SOUND_ID}（`none` 是合法值，不会被改掉）
 */
export function normalizeSoundId(raw: unknown): SoundId {
  if (typeof raw !== 'string') return DEFAULT_SOUND_ID;
  const normalized = raw.trim().toLowerCase();
  return SOUND_IDS.includes(normalized as SoundId) ? (normalized as SoundId) : DEFAULT_SOUND_ID;
}

/**
 * 读偏好。
 *
 * @returns 存储不可用（隐私模式 / 异常 profile）或值损坏时的默认音效
 */
export function readSoundPreference(): SoundId {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_SOUND_ID;
    return normalizeSoundId(localStorage.getItem(SOUND_STORAGE_KEY));
  } catch {
    return DEFAULT_SOUND_ID;
  }
}

/** 写偏好。写不进去只影响下次启动的默认值，不值得打断设置流程。 */
export function writeSoundPreference(id: SoundId): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SOUND_STORAGE_KEY, normalizeSoundId(id));
  } catch {
    // 忽略：没有存储可用时设置只在本次会话内有效
  }
}

/**
 * 复用一个 AudioContext。
 *
 * <p>每次播放新建会在部分系统上留下未关闭的音频流，且首次创建有额外延迟。</p>
 */
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext;
  if (!Ctor) return null;
  if (!audioContext) audioContext = new Ctor();
  return audioContext;
}

/** 测试与排障用：丢掉已缓存的 AudioContext。 */
export function resetSoundEngine(): void {
  audioContext = null;
}

/**
 * 播放一次提示音。
 *
 * @param id 音效 id；`none` 直接静音，连 AudioContext 都不碰
 * @returns 是否真的排上了音（环境不支持、被策略拦住、解码失败都返回 false，绝不抛）
 */
export function playNotificationSound(id: SoundId): boolean {
  if (id === 'none') return false;

  try {
    const ctx = getAudioContext();
    if (!ctx) return false;

    // 通知窗口没有用户手势，AudioContext 可能停在 suspended，必须催一次。
    // 实测 Electron 默认策略下新建窗口就是 running（见 .lingxi/tmp/audio-probe.cjs），
    // 这里只是兜底：别的环境/策略组合不该让提示音整体哑掉。
    // resume 失败也无所谓：这次就静音，不影响卡片本身。
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);

    // 留 20ms 排期，否则第一批音符会被已经过去的 currentTime 吃掉
    const startAt = ctx.currentTime + 0.02;
    for (const tone of RECIPES[id]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const from = startAt + tone.startMs / 1000;
      const to = from + tone.durationMs / 1000;

      osc.type = tone.type;
      osc.frequency.setValueAtTime(tone.freq, from);
      if (tone.endFreq) osc.frequency.exponentialRampToValueAtTime(tone.endFreq, to);

      // 指数衰减自带「敲击感」；线性衰减听着像被掐断
      gain.gain.setValueAtTime(0, from);
      gain.gain.linearRampToValueAtTime(tone.gain, from + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, to);

      osc.connect(gain);
      gain.connect(master);
      osc.start(from);
      osc.stop(to + 0.02);
    }
    return true;
  } catch {
    // 音频栈出问题就安静地放弃：提醒的主体是卡片，不是声音
    return false;
  }
}
