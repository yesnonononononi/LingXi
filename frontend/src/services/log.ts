import http from './interceptor';
import type { Result } from './types';
import type { LogLocationVO } from '../types/chat';

/**
 * 日志位置 API (对应后端 LogController)。
 *
 * <p>位置由后端进程自己报告，前端不自行拼接 —— 桌面端可能复用一个已在跑的实例（IDE 里起的、
 * 上次残留的），那种实例的日志目录不是本次启动器算出来的，前端照自己的值拼就会指错。</p>
 */
export class LogAPI {
  /** WARN/ERROR 日志（含堆栈）文件的位置；文件预览面板直接打开它。 */
  static async location(): Promise<Result<LogLocationVO>> {
    return http.get<any, Result<LogLocationVO>>('/log/location');
  }
}
