import http from './interceptor';
import type { Result } from './types';

export type SecurityCategory = 'files' | 'terminal' | 'net';
export type SecurityAction = 'ALLOW' | 'ASK' | 'DENY';
export interface SecurityRule {
  pattern: string;
  matchType: 'PATH' | 'PROGRAM' | 'PREFIX' | 'ANY';
  read: SecurityAction | null;
  write: SecurityAction | null;
  delete: SecurityAction | null;
  action: SecurityAction | null;
  enabled: boolean;
  preset: string | null;
}
export interface SecurityRuleView {
  category: SecurityCategory;
  revision: number;
  rules: SecurityRule[];
  supportedActions: SecurityAction[];
  defaultAction: SecurityAction;
  activation: 'CONFIGURATION_ONLY';
}
export class SecurityRulesAPI {
  static current(category: SecurityCategory): Promise<Result<SecurityRuleView>> {
    return http.get(`/sandbox/security/${category}`);
  }
  static save(category: SecurityCategory, revision: number, rules: SecurityRule[]): Promise<Result<SecurityRuleView>> {
    return http.put(`/sandbox/security/${category}`, { revision, rules });
  }
  static defaults(category: SecurityCategory): Promise<Result<SecurityRule[]>> {
    return http.post(`/sandbox/security/${category}/defaults`);
  }
}
