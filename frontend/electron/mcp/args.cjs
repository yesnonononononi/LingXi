/**
 * MCP 工具入参归一。
 *
 *schema 里写给模型的上下限必须和执行时的裁剪同源：上下限常量由工具定义引用，
 * 裁剪也走这里。分成两处各写一个数字，改一处就是静默漂移。
 *
 *语义统一：非有限数或低于下限视为「没给合法值」，回退 fallback；超过上限按上限裁剪。
 * 下限允许 0 的字段（如 viewportWidth）把 min 设成 0，0 会原样保留。
 */

/**
 * 归一整数入参。
 *
 * @param value 模型给的原始值
 * @param options 裁剪配置：fallback / min / max
 * @returns 归一后的整数
 */
function normalizeInt(value, {fallback, min, max}) {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  if (rounded < min) return fallback;
  return rounded > max ? max : rounded;
}

/** 归一可缺省文本：非字符串一律视为未提供。 */
function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 布尔归一：只认显式布尔与字符串 true/false，其余回退。 */
function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** 枚举归一：不在候选集内按 fallback 处理。 */
function normalizeEnum(value, allowed, fallback) {
  const text = normalizeText(value).toLowerCase();
  return allowed.includes(text) ? text : fallback;
}

module.exports = {normalizeInt, normalizeText, normalizeBoolean, normalizeEnum};
