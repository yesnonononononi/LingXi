/**
 * 动作宿主守卫（M6-b 第三轮）：动作动画**不许**挂回压平帧。
 *
 * <p><b>守的是什么：</b>`pet.css` 在 `data-composite-mode='layered'` 下把
 * `.pet-art-frame` 整帧 `opacity: 0`（分层让位，否则会出现"两条尾巴"的重影）。
 * 一旦动作动画（tap / happy / surprised / angry / wake / drag）又挂回压平帧，
 * 动画就作用在一个看不见的元素上——用户点一下只看到耳朵和呆毛颤一下，
 * 而 DOM 里 `data-motion='tap'` 一切正常，"看起来什么都没坏"。
 * 这条缺陷只能靠文本锚定的守卫拦住（UI 层没有肉眼可见的异常信号）。</p>
 *
 * <p><b>为什么用文本锚定而不是渲染断言：</b>纯 node 环境没有 CSSOM；
 * 而真正的"用户能看见"验收在 DOM 探针里做（`opacity / animationName / 位移`）。
 * 这里管的是"下一个人别改回去"，所以直接锚定 CSS 的消费者签名。</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** `pet.css` 全文（去掉注释，避免注释里的示例选择器干扰断言）。 */
const CSS: string = readFileSync(resolve(process.cwd(), 'src/pet/pet.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 动作宿主类名（真源：`pet.css` 与 `main.ts` 的 `.pet-action`）。 */
const ACTION_HOST = '.pet-action';
/** 压平帧类名（layered 下被 `opacity: 0` 让位的那个）。 */
const FRAME = '.pet-art-frame';

/** 一条 CSS 规则（选择器 + 声明块）。 */
interface CssRule {
  /** 选择器文本（可能是逗号分隔的选择器列表）。 */
  readonly selector: string;
  /** 声明块文本。 */
  readonly body: string;
}

/**
 * 粗略切分规则（不处理嵌套：@media 内部的规则会被单独匹配出来，
 * 因为 `[^{}]+` 在遇到内层 `{` 时无法继续，正则会在下一个起点重试）。
 *
 * @param css 已去注释的样式表
 * @returns 规则列表
 */
function splitRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let matched: RegExpExecArray | null = pattern.exec(css);
  while (matched !== null) {
    rules.push({ selector: matched[1].trim(), body: matched[2].trim() });
    matched = pattern.exec(css);
  }
  return rules;
}

/** 全部规则。 */
const RULES: CssRule[] = splitRules(CSS);

/** 目标选择器里出现的、与 `data-motion` 相关的动作动画规则（只取声明了 animation-name 的）。 */
const MOTION_NAME_RULES: CssRule[] = RULES.filter(
  (rule) => rule.selector.includes('[data-motion') && /animation-name\s*:/.test(rule.body),
);

test('守卫：动作动画规则必须存在（6 个动作各一条，防止被整体删掉）', () => {
  const ids = ['tap', 'happy', 'surprised', 'angry', 'wake', 'drag'];
  for (const id of ids) {
    const found = MOTION_NAME_RULES.some(
      (rule) => rule.selector.includes(`[data-motion='${id}']`) && rule.selector.includes(ACTION_HOST),
    );
    assert.ok(found, `缺少 ${id} 的动作动画规则，或宿主不是 ${ACTION_HOST}`);
  }
});

test('守卫：动作动画的宿主一律是 .pet-action，绝不落到 .pet-art-frame', () => {
  assert.ok(MOTION_NAME_RULES.length >= 6, `动作动画规则过少（${MOTION_NAME_RULES.length}），守卫失去意义`);
  for (const rule of MOTION_NAME_RULES) {
    assert.equal(
      rule.selector.includes(FRAME),
      false,
      `动作动画又挂回压平帧了：在 layered 下 .pet-art-frame 的 opacity 为 0，动画等于没播。冒犯规则：${rule.selector}`,
    );
    assert.ok(
      rule.selector.includes(ACTION_HOST),
      `动作动画的宿主必须是 ${ACTION_HOST}（两种合成模式下都可见）。冒犯规则：${rule.selector}`,
    );
  }
});

test('守卫：任何挂 .pet-art-frame 的规则都不许声明动画（animation / animation-name / animation-duration）', () => {
  for (const rule of RULES) {
    if (!rule.selector.split(',').some((item) => item.includes(FRAME))) continue;
    // 例外：`animation: none` 之类的"关闭"是允许的（减少动效 / 支撑层）
    const declaring = /(^|;)\s*animation[a-z-]*\s*:/.test(rule.body);
    if (!declaring) continue;
    const onlyNone = /(^|;)\s*animation[a-z-]*\s*:\s*none\s*(;|$)/.test(rule.body);
    assert.ok(onlyNone, `压平帧上不许再有任何动画（它会被整帧隐藏）：${rule.selector} { ${rule.body} }`);
  }
});

test('守卫：layered 的隐藏规则只命中压平帧，不命中动作宿主', () => {
  const hideRules = RULES.filter(
    (rule) => rule.selector.includes("[data-composite-mode='layered']") && /opacity\s*:\s*0/.test(rule.body),
  );
  assert.equal(hideRules.length, 1, `layered 下应恰好有一条整帧让位规则，实际 ${hideRules.length} 条`);
  const [hide] = hideRules;
  assert.ok(hide.selector.includes(FRAME), 'layered 让位规则的对象应该是压平帧');
  assert.equal(
    hide.selector.includes(ACTION_HOST),
    false,
    `动作宿主被一起隐藏了：${hide.selector}。动作会再次变成"看不见的动画"`,
  );
});

test('守卫：动作宿主自身是静态同框的（inset: 0 + 事件穿透），保证静止时命中几何不变', () => {
  const host = RULES.find((rule) => rule.selector === ACTION_HOST);
  assert.ok(host, `pet.css 缺少 ${ACTION_HOST} 规则`);
  assert.ok(/inset\s*:\s*0/.test(host.body), `${ACTION_HOST} 必须 inset: 0（静止时与 .pet-art 逐像素同框）`);
  assert.ok(/pointer-events\s*:\s*none/.test(host.body), `${ACTION_HOST} 必须事件穿透（命中仍由 .pet-art 收）`);
});

test('守卫：动作宿主永远不被设为 opacity: 0 / visibility: hidden / display: none', () => {
  for (const rule of RULES) {
    if (!rule.selector.split(',').some((item) => item.trim() === ACTION_HOST || item.includes(`${ACTION_HOST}[`) || item.includes(`${ACTION_HOST} `))) continue;
    assert.equal(
      /opacity\s*:\s*0\b/.test(rule.body) || /visibility\s*:\s*hidden/.test(rule.body) || /display\s*:\s*none/.test(rule.body),
      false,
      `动作宿主被隐藏了：${rule.selector}`,
    );
  }
});

test('守卫：composite 下只有一个位移源（动作宿主的 transform 关键帧，帧上零动画）', () => {
  // 关键帧名只被"动作宿主规则"消费：数一条关键帧被引用的规则，必须全在 .pet-action 上
  const keyframes = [...CSS.matchAll(/@keyframes\s+(pet-[a-z-]+)\s*\{/g)].map((match) => match[1]);
  const motionKeys = keyframes.filter((name) => ['pet-tap', 'pet-hop-lite', 'pet-hop', 'pet-shake', 'pet-lift'].includes(name));
  assert.deepEqual(motionKeys.sort(), ['pet-hop', 'pet-hop-lite', 'pet-lift', 'pet-shake', 'pet-tap']);
  for (const rule of RULES) {
    if (!/animation(-name)?\s*:\s*pet-(tap|hop|hop-lite|shake|lift)\b/.test(rule.body)) continue;
    assert.ok(
      rule.selector.includes(ACTION_HOST),
      `动作关键帧被非动作宿主消费（会出现双份位移）：${rule.selector}`,
    );
  }
});
