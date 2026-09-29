/**
 * 后端响应判定与工具函数的唯一实现。
 *
 * 契约来源：com.summit.ddd.application.vo.Result
 *   - success() 恒写入 code = 1（Result.success 的 iconst_1）
 *   - error()   恒写入 code = 0，错误文案在 errMsg 字段
 * 后端从不返回 200，因此只接受 1。
 *
 * 本地单实例（HC-1）：无账号体系，不存在鉴权头拼接。
 */

/** 后端成功业务码集合 */
export const SUCCESS_CODES: readonly number[] = [1];

/**
 * 判定后端业务码是否为成功。
 * 仅接受有限数值，杜绝 `undefined` / `NaN` / 字符串被误判为成功。
 */
export function isOk(code?: number | string | null): boolean {
  if (code === null || code === undefined || code === '') return false;
  const n = typeof code === 'number' ? code : Number(code);
  return Number.isFinite(n) && SUCCESS_CODES.includes(n);
}

/** 判定后端响应是否成功且携带数据 */
export function isOkWithData<T>(res: { code?: number | string; data?: T } | null | undefined): res is { code?: number | string; data: T } {
  return !!res && isOk(res.code) && res.data !== null && res.data !== undefined;
}

/**
 * 安全取整：用于分页等必须为有效数字的场景。
 * 解析失败返回 fallback，绝不返回 NaN。
 */
export function toPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
