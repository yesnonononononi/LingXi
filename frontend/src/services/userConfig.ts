import http from './interceptor';
import type { Result } from './types';
import type { UserConfigVO, WorkspaceEnvType } from '../types/chat';
import { isOk } from '../utils/api';
import { normalizeWorkspaceEnvType } from '../utils/enum';

/** 4.5 通用配置 API (对应后端 UserConfigController) */
export class UserConfigAPI {
  static async current(): Promise<Result<UserConfigVO>> {
    return http.get<any, Result<UserConfigVO>>('/config/current');
  }

  /** 更新单例本地设置（如选中的模型 modelId）；未传字段保持原值。 */
  static async updateCurrent(payload: Partial<UserConfigVO>): Promise<Result<void>> {
    return http.post<any, Result<void>>('/config/current/update', payload);
  }

  /**
   * 工作空间类型的唯一来源：GET /config/current（单例设置已落库，不再读本地缓存）。
   * 契约来源：contract §5 —— 后端下发枚举名 `SAND_BOX` / `LOCAL` / `NONE`（非小写 sandbox）。
   * 未识别 / 查询失败时回落默认沙箱 `SAND_BOX`。
   */
  static async currentWorkspaceType(): Promise<WorkspaceEnvType> {
    try {
      const res = await UserConfigAPI.current();
      if (isOk(res?.code)) {
        const resolved = normalizeWorkspaceEnvType(res.data?.type);
        if (resolved) return resolved;
        console.warn('[UserConfigAPI] 未识别的环境类型，回落默认沙箱:', res.data?.type);
      }
    } catch (err) {
      console.warn('[UserConfigAPI] 读取工作空间类型失败，回落默认沙箱:', err);
    }
    return 'SAND_BOX';
  }
}
