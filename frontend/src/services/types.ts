/** 通用统一响应接口 */
export interface Result<T = any> {
  code: number;
  errMsg?: string;
  data?: T;
}
