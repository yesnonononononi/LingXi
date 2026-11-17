import type {SessionTokenAuditVO} from './tokenAudit';

/**
 * 手工压缩（`/compact`）回执。
 *
 * <p>后端一次把「最新用量」与「重算后的审计」一起给出：用户按一次按钮想看的就是这两件事，
 * 让前端分两次请求、或只靠推送补一半，都会出现「压缩成功但量不出变化」的空窗。</p>
 *
 * <p>`compacted === false` 时 `audit` 为空：上下文没有被改写，下发上一份快照会让
 * 「压缩完还是这么大」变成完全合理的错觉。</p>
 */
export interface ContextCompactionResult {
  /** 上下文是否真的被重写。 */
  compacted: boolean;
  /** 压缩前已用 token；null/缺省表示模型未配置上下文窗口。 */
  tokensBefore?: number | null;
  /** 压缩后已用 token；未压缩时不重复下发。 */
  tokensAfter?: number | null;
  /** 是否成功重算并落库了审计快照（与压缩是否成功无关）。 */
  auditRefreshed?: boolean;
  /** 后端说明文案（成功摘要 / 未压缩原因）。 */
  message?: string | null;
  /** 重算后的会话级审计快照。 */
  audit?: SessionTokenAuditVO | null;
}
