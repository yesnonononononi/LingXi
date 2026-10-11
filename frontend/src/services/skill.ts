import http from './interceptor';
import type { Result } from './types';
import type { SkillVO } from '../types/chat';

/** 本地 Skill API (对应后端 SkillController) */
export class SkillAPI {
  /** 获取本地 Skill 清单 (GET /skill/list)；能力未开启时 data 为空数组 */
  static async list(): Promise<Result<SkillVO[]>> {
    return http.get<any, Result<SkillVO[]>>('/skill/list');
  }
}
