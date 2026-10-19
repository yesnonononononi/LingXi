// 台词库。按表情分组，选台词用纯函数，方便测试。

export const BUBBLES = Object.freeze({
  normal: ['…', '在的', '嗯？', '要我做什么'],
  happy: ['嘿嘿~', '摸摸头！', '再摸一下嘛', '哇，好开心'],
  angry: ['别戳了！', '喵！生气了', '再点就咬你', '烦死了啦'],
  shy: ['呀…！', '放我下来啦', '有点晕…', '别拎着我'],
  sleepy: ['好困…', 'Zzz…', '别吵…', '让我再睡会儿'],
  excited: ['醒啦！', '！？发生什么了', '喵呜～', '你回来啦'],
});

/** 每句气泡的展示时长（毫秒）。短句飘太快看不清。 */
export const BUBBLE_DURATION_MS = 2_600;

/**
 * 从某表情的台词里挑一句。
 * pick 允许注入随机源，测试里用固定序列断言不会越界、不会返回 undefined。
 * @param {string} face 表情名
 * @param {(max:number)=>number} pick 返回 [0, max) 的整数
 */
export function pickBubble(face, pick) {
  const pool = BUBBLES[face] ?? BUBBLES.normal;
  const index = pick(pool.length);
  const safeIndex = ((index % pool.length) + pool.length) % pool.length;
  return pool[safeIndex];
}
