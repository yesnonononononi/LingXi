import http from './interceptor';
import type { Result } from './types';
import type { SandboxServiceStatus } from '../types/chat';

/**
 * 安装沙箱服务的等待上限。
 *
 * <p>不能沿用 10s 默认值：Windows 上这一步会弹 UAC 等用户点确认，用户在授权框上多停一会
 * 请求就超时了，而后端其实还在装 —— 前端会误报成网络失败，用户再点一次又要挨一个 UAC。</p>
 */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** 沙箱服务 API (对应后端 SandboxController) */
export class SandboxAPI {
  /**
   * 沙箱服务状态 (GET /sandbox/service/status)。
   *
   * <p>只做文件与平台检测，不跑任何命令，也不提权。</p>
   */
  static async status(): Promise<Result<SandboxServiceStatus>> {
    return http.get<any, Result<SandboxServiceStatus>>('/sandbox/service/status');
  }

  /**
   * 安装沙箱服务 (POST /sandbox/service/install)。
   *
   * <p>Windows 上会弹 UAC 注册系统组件；已装过也可重装。失败时后端只给一句可读文案，
   * 详细的 exit code 与 SRT 原文在错误日志里。</p>
   */
  static async install(): Promise<Result<SandboxServiceStatus>> {
    return http.post<any, Result<SandboxServiceStatus>>(
      '/sandbox/service/install', null, { timeout: INSTALL_TIMEOUT_MS },
    );
  }
}
