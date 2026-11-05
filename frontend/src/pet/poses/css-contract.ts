/**
 * 姿态层的**可见性 CSS 契约**：`data-posture` 与三层互斥规则的唯一真源。
 *
 * <p><b>为什么把它单列成一个模块：</b>G-01（不穿模·单一可见源）的判据是"`pet.css` 里必须
 * 精确存在两条 `:not([data-posture='stand'])` 规则和一条 `[data-posture='stand']` 规则"。
 * 这条断言有两处要用（`petPosePlayer.test.ts` 与 `petPoseEnvelope.test.ts`），
 * 而"解析 CSS 文本"的代码一旦抄两份，改一份漏一份就会让守卫悄悄失去一半威力。
 * 所以选择器常量与匹配器都放在这里，测试只消费它们。</p>
 *
 * <p><b>为什么判据是 `display: none` 而不是 `opacity: 0`：</b>后者仍然参与合成与
 * `drop-shadow` 滤镜计算，白烧 GPU，而且会与姿态层的投影叠加成双影——
 * 那正是"穿模"要防的形态。所以本模块把"用 opacity 藏层"当成错误直接报出来。</p>
 *
 * @module pet/poses/css-contract
 */

/** 姿态属性名（写在 `#pet-root` 上；`controller.ts` 是唯一写入者）。 */
export const POSTURE_ATTRIBUTE = 'data-posture';

/** 站姿取值（未设置属性时**不能**当成站姿：CSS 用 `:not()` 取补集）。 */
export const STAND_POSTURE_VALUE = 'stand';

/** 会被"非站姿"规则藏起来的两个层（动作宿主与层栈）。 */
export const HIDDEN_BY_POSE_CLASS_NAMES = Object.freeze(['pet-action', 'pet-layers']);

/** 只在站姿可见的层（姿态画面）。 */
export const POSE_LAYER_CLASS_NAME = 'pet-pose';

/** 姿态图元素属性（DOM 里恒为 1 个，G-03）。 */
export const POSE_FRAME_ATTRIBUTE = 'data-pose-frame';

/** 三层互斥规则的期望形态（`pet.css` 必须逐条存在）。 */
export const POSE_VISIBILITY_CONTRACT = Object.freeze({
  /** 非站姿 ⇒ 藏掉动作宿主与层栈。 */
  nonStandHides: HIDDEN_BY_POSE_CLASS_NAMES,
  /** 站姿 ⇒ 藏掉姿态层。 */
  standHides: POSE_LAYER_CLASS_NAME,
});

/** 姿态可见性管辖的三个层名（其余层的 `opacity: 0` 是淡入淡出，不算"藏层"）。 */
const MANAGED_CLASS_NAMES: ReadonlySet<string> = new Set<string>([
  ...HIDDEN_BY_POSE_CLASS_NAMES,
  POSE_LAYER_CLASS_NAME,
]);

/** 一条 CSS 规则的解析结果。 */
export interface ParsedCssRule {
  /** 原始选择器（含前导 `#pet-root`）。 */
  readonly selector: string;
  /** 声明块原文。 */
  readonly declarations: string;
}

/**
 * 去掉 CSS 注释（保留换行，便于报错行号）。
 *
 * @param css CSS 文本
 * @returns 去注释后的文本
 */
export function stripCssComments(css: string): string {
  return String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 把 CSS 文本拆成规则列表（只处理裸规则，不处理 `@media` 嵌套里的规则内容）。
 *
 * <p>够用即可：本契约只关心 `#pet-root[data-posture…]` 这类顶层规则。`@media` 内的
 * 同名规则会被当成普通规则收进来（它们的声明同样生效，收进来是正确的）。</p>
 *
 * @param css CSS 文本
 * @returns 规则列表
 */
export function parseCssRules(css: string): ParsedCssRule[] {
  const text = stripCssComments(css);
  const rules: ParsedCssRule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const selector = match[1].trim();
    const declarations = match[2].trim();
    // `@media (...) { ... }` 的外壳会被匹配成"选择器以 @ 开头、声明是空"的伪规则，跳过
    if (selector.length > 0 && !selector.startsWith('@')) rules.push({ selector, declarations });
    match = pattern.exec(text);
  }
  return rules;
}

/** 可见性匹配结果。 */
export interface PoseVisibilityMatch {
  /** 被"非站姿"规则藏掉的层名（如 `pet-action`）。 */
  readonly nonStandHides: readonly string[];
  /** 被"站姿"规则藏掉的层名（应为 `pet-pose`）。 */
  readonly standHides: readonly string[];
  /** 命中 `#pet-root` 前缀的规则条数（防空集通过）。 */
  readonly rootPrefixedRules: number;
  /** 用 `opacity` 藏层的规则（错误形态，非空即失败）。 */
  readonly opacityHides: readonly string[];
}

/**
 * 从 CSS 文本里摘出姿态可见性相关的规则。
 *
 * @param css CSS 文本
 * @returns 匹配结果
 */
export function matchPoseVisibility(css: string): PoseVisibilityMatch {
  const nonStand = new Set<string>();
  const stand = new Set<string>();
  const opacityHides: string[] = [];
  let rootPrefixedRules = 0;
  for (const rule of parseCssRules(css)) {
    const selectors = rule.selector.split(',').map((item) => item.trim());
    const isRootPrefixed = selectors.some((selector) => selector.startsWith('#pet-root'));
    if (isRootPrefixed && /data-posture/.test(rule.selector)) rootPrefixedRules += 1;
    const hidesByDisplay = /display\s*:\s*none/i.test(rule.declarations);
    const hidesByOpacity = /opacity\s*:\s*0(?![.\d])/i.test(rule.declarations);
    if (!hidesByDisplay && !hidesByOpacity) continue;
    for (const selector of selectors) {
      if (!selector.startsWith('#pet-root')) continue;
      const target = /\.(pet-[a-z-]+)/.exec(selector);
      if (!target) continue;
      const className = target[1];
      // 只关心"姿态可见性"涉及的三个层；`pet-hint` 之类的 `opacity: 0` 是淡入淡出，不是藏层
      if (!MANAGED_CLASS_NAMES.has(className)) continue;
      const isNonStandRule = /:not\(\[data-posture\s*=\s*'stand'\]\)/.test(selector);
      const isStandRule = /\[data-posture\s*=\s*'stand'\]/.test(selector) && !isNonStandRule;
      if (hidesByOpacity) opacityHides.push(`${selector} { ${rule.declarations} }`);
      if (isNonStandRule && hidesByDisplay) nonStand.add(className);
      if (isStandRule && hidesByDisplay) stand.add(className);
    }
  }
  return {
    nonStandHides: [...nonStand].sort(),
    standHides: [...stand].sort(),
    rootPrefixedRules,
    opacityHides,
  };
}

/**
 * 校验 `pet.css` 是否满足互斥契约（G-01 的纯函数形态）。
 *
 * @param css CSS 文本
 * @returns 问题列表（空数组 = 通过）
 */
export function poseVisibilityProblems(css: string): string[] {
  const problems: string[] = [];
  const matched = matchPoseVisibility(css);
  for (const className of POSE_VISIBILITY_CONTRACT.nonStandHides) {
    if (!matched.nonStandHides.includes(className)) {
      problems.push(
        `缺少规则「#pet-root:not([${POSTURE_ATTRIBUTE}='${STAND_POSTURE_VALUE}']) .${className} { display: none; }」` +
          '（删掉它，姿态画面会与动作层/层栈同时可见 = 穿模）',
      );
    }
  }
  if (!matched.standHides.includes(POSE_VISIBILITY_CONTRACT.standHides)) {
    problems.push(
      `缺少规则「#pet-root[${POSTURE_ATTRIBUTE}='${STAND_POSTURE_VALUE}'] .${POSE_VISIBILITY_CONTRACT.standHides} ` +
        '{ display: none; }」（删掉它，站姿时姿态层会盖在立绘上）',
    );
  }
  if (matched.rootPrefixedRules === 0) {
    problems.push(
      `没有任何以 #pet-root 前缀的 ${POSTURE_ATTRIBUTE} 规则：选择器改名后"匹配到 0 条"必须算失败，不能空集通过`,
    );
  }
  if (matched.opacityHides.length > 0) {
    problems.push(
      `用 opacity 藏层：${matched.opacityHides.join('; ')}` +
        '（必须用 display:none —— opacity:0 仍参与合成与 drop-shadow，会叠出双影）',
    );
  }
  return problems;
}
