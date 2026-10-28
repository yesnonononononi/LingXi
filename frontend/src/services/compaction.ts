import http from './interceptor';
import type { Result } from './types';
import type { CompactionParamsVO } from '../types/chat';

/**
 * 上下文压缩的只读参数 API（对应后端 SettingsController#compaction）。
 *
 * <p>三个值都在框架启动期由 yaml 绑定，页面只展示真值；要改它们得改配置并重启，
 * 所以这里没有写入口 —— 别在前端再抄一份默认值，抄出来的第二份必然与后端漂移。</p>
 */
export class CompactionSettingsAPI {
  static async params(): Promise<Result<CompactionParamsVO>> {
    return http.get<any, Result<CompactionParamsVO>>('/settings/compaction');
  }
}
