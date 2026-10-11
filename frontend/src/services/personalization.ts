import http from './interceptor';
import type { Result } from './types';

export interface PersonalizationVO {
  id: string | number;
  title: string | null;
  commonAgentName: string | null;
  replyStyle: string;
  customInstruction: string | null;
}

export interface ReplyStyleOption {
  value: string;
  label: string;
}

export type PersonalizationDraft = Pick<PersonalizationVO, 'title' | 'commonAgentName' | 'replyStyle' | 'customInstruction'>;

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
