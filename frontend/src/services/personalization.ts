import http from './interceptor';
import type {Result} from './types';
import type {ShortcutMap} from '../utils/shortcuts';

export interface PersonalizationVO {
  id: string | number;
  title: string | null;
  commonAgentName: string | null;
  replyStyle: string;
  customInstruction: string | null;
  /** 动作名 -> 组合键文本；从未配置过快捷键的老档返回 null，由前端回落默认值。 */
  shortcuts?: Record<string, string> | null;
}

export interface ReplyStyleOption {
  value: string;
  label: string;
}

/** 提交时快捷键始终是完整的一份（缺项已由 normalizeShortcutMap 补默认值）。 */
export type PersonalizationDraft = Pick<PersonalizationVO, 'title' | 'commonAgentName' | 'replyStyle' | 'customInstruction'> & {
  shortcuts: ShortcutMap;
};

export class PersonalizationAPI {
  static current(): Promise<Result<PersonalizationVO>> {
    return http.get<any, Result<PersonalizationVO>>('/personalization/current');
  }

  static replyStyles(): Promise<Result<ReplyStyleOption[]>> {
    return http.get<any, Result<ReplyStyleOption[]>>('/personalization/reply-styles');
  }

  static update(payload: PersonalizationDraft & { id: string | number }): Promise<Result<void>> {
    return http.post<any, Result<void>>('/personalization/update', payload);
  }
}
