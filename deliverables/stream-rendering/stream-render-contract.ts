/** 展示身份按字符串传输，避免雪花 ID 丢失精度。 */
export type ViewId = string;

export type TurnStatus =
  | 'ACCEPTED'
  | 'RUNNING'
  | 'WAITING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type TextStatus = 'STREAMING' | 'COMPLETE' | 'INTERRUPTED';

export type ToolStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface RenderActionVO {
  action_id: ViewId;
  kind: 'APPROVE' | 'REJECT' | 'ANSWER' | 'OPEN_SESSION';
  label: string;
  enabled: boolean;
  disabled_reason: string | null;
}

export interface SessionDirectoryVO {
  root_session_id: ViewId;
  session_ids: ViewId[];
}

export interface SessionContextVO {
  token_count: number | null;
  max_tokens: number | null;
  ratio: number | null;
  activity: 'IDLE' | 'COMPRESSING';
  activity_label: string | null;
}

export interface HistoryWindowVO {
  has_more: boolean;
  before_cursor: string | null;
}

export interface ChatSessionViewVO {
  session_id: ViewId;
  parent_session_id: ViewId | null;
  title: string;
  turn_ids: ViewId[];
  history: HistoryWindowVO | null;
  context: SessionContextVO;
}

export interface TurnSummaryVO {
  model_name: string | null;
  model_provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  started_at: string | null;
  completed_at: string | null;
  elapsed_ms: number | null;
}

export interface ChatTurnViewVO {
  turn_id: ViewId;
  session_id: ViewId;
  parent_turn_id: ViewId | null;
  status: TurnStatus;
  status_label: string;
  bubble_ids: ViewId[];
  footer_bubble_id: ViewId | null;
  copy_block_ids: ViewId[];
  summary: TurnSummaryVO;
  error_reason: string | null;
}

export interface BubbleActivityVO {
  kind: 'IDLE' | 'GENERATING' | 'USING_TOOL' | 'WAITING';
  label: string | null;
}

export interface ChatBubbleVO {
  bubble_id: ViewId;
  turn_id: ViewId;
  role: 'USER' | 'ASSISTANT';
  lifecycle: 'OPEN' | 'CLOSED';
  block_ids: ViewId[];
  activity: BubbleActivityVO;
}

export interface TextBlockVO {
  block_id: ViewId;
  bubble_id: ViewId;
  kind: 'TEXT';
  purpose: 'UNDECIDED' | 'NARRATION' | 'ANSWER';
  status: TextStatus;
  format: 'MARKDOWN' | 'PLAIN';
  segment_ids: ViewId[];
}

export interface ReasoningBlockVO {
  block_id: ViewId;
  bubble_id: ViewId;
  kind: 'REASONING';
  status: TextStatus;
  title: string;
  initially_expanded: boolean;
  segment_ids: ViewId[];
}

export type ToolDetailVO =
  | {
      kind: 'GENERIC';
      preview: string | null;
      detail_ref: string | null;
    }
  | {
      kind: 'COMMAND';
      command: string;
      working_directory: string | null;
      output_preview: string | null;
      detail_ref: string | null;
    }
  | {
      kind: 'FILE';
      path: string;
      operation: 'READ' | 'WRITE' | 'EDIT';
      added_lines: number | null;
      removed_lines: number | null;
      detail_ref: string | null;
    }
  | {
      kind: 'SUB_SESSION';
      session_id: ViewId;
      task: string | null;
    };

export interface ToolBlockVO {
  block_id: ViewId;
  bubble_id: ViewId;
  kind: 'TOOL';
  tool_call_id: ViewId;
  tool_name: string;
  title: string;
  status: ToolStatus;
  status_label: string;
  detail: ToolDetailVO;
  actions: RenderActionVO[];
}

export interface NoticeBlockVO {
  block_id: ViewId;
  bubble_id: ViewId;
  kind: 'NOTICE';
  level: 'INFO' | 'WARNING';
  text: string;
}

export type ChatBlockVO =
  | TextBlockVO
  | ReasoningBlockVO
  | ToolBlockVO
  | NoticeBlockVO;

/** 分片只限制传输大小；Markdown 始终在所属块拼接后解析。 */
export interface TextSegmentVO {
  segment_id: ViewId;
  block_id: ViewId;
  text: string;
}

export interface ChatRenderViewVO {
  directory: SessionDirectoryVO;
  sessions: Record<ViewId, ChatSessionViewVO>;
  turns: Record<ViewId, ChatTurnViewVO>;
  bubbles: Record<ViewId, ChatBubbleVO>;
  blocks: Record<ViewId, ChatBlockVO>;
  segments: Record<ViewId, TextSegmentVO>;
}

/** 每项都是完整实体，避免局部对象合并与 null 清除产生歧义。 */
export interface RenderEntityBatchVO {
  sessions: ChatSessionViewVO[];
  turns: ChatTurnViewVO[];
  bubbles: ChatBubbleVO[];
  blocks: ChatBlockVO[];
  segments: TextSegmentVO[];
}

export interface RenderRemovalVO {
  session_ids: ViewId[];
  turn_ids: ViewId[];
  bubble_ids: ViewId[];
  block_ids: ViewId[];
  segment_ids: ViewId[];
}

export interface ViewRequestResultVO {
  request_id: ViewId;
  status: 'COMPLETED' | 'FAILED';
  error_message: string | null;
}

export interface ViewResetVO {
  schema_version: 1;
  type: 'VIEW_RESET';
  subscription_id: ViewId;
  view: ChatRenderViewVO;
}

export interface ViewPatchVO {
  schema_version: 1;
  type: 'VIEW_PATCH';
  subscription_id: ViewId;
  directory: SessionDirectoryVO | null;
  upsert: RenderEntityBatchVO;
  remove: RenderRemovalVO;
  request_results: ViewRequestResultVO[];
}

export type ChatRenderEventVO = ViewResetVO | ViewPatchVO;

export interface ChatAcceptanceVO {
  command_id: ViewId;
  root_session_id: ViewId;
  session_id: ViewId;
  turn_id: ViewId;
}

export interface LoadHistoryRequest {
  request_id: ViewId;
  subscription_id: ViewId;
  session_id: ViewId;
  before_cursor: string | null;
}
