/**
 * Block 展示契约的 TypeScript 映射（唯一手写契约层）。
 *
 * <p><b>真源：</b>后端 {@code com.summit.dp.shared.vo.block} 包 +
 * {@code com.summit.dp.shared.event.BlockEventType}。历史查询（{@code SessionMessagePageVO.turnViews}）
 * 与实时 SSE（{@code TURN_SNAPSHOT} / {@code BLOCK_UPSERT}）共用这一份形状 ——
 * 这正是本次改造要收掉「历史一套、实时一套」的地方。</p>
 *
 * <p><b>为什么不复用前端自造的排序/去重</b>：{@link Block#order} 与 {@link Block#blockId}
 * 全部由后端唯一确定（后端装配器 = 历史与实时同一份实现）。前端只负责按 order 升序渲染、
 * 按 blockId 替换 —— 不再自己算 order、不再用内容指纹猜身份。</p>
 *
 * <p><b>序列化约定</b>：Long → 十进制字符串（雪花 ID 超 JS 安全整数范围），
 * 故 id 一律是 {@code string}。</p>
 */

/** 块类型判别式（对应后端 {@code Block.TYPE_*}）。 */
export type BlockType = 'THINKING' | 'TEXT' | 'TOOL';

/**
 * 块状态（对应后端 {@code BlockStatus}）。
 *
 * <p>⚠️ 这是**块**的生命周期状态，不是工具的业务结论。工具块的结论（成功/失败/被拒/超时）
 * 由后端从框架 {@code ToolCallStatus} 映射进 {@code status}，前端**不得**再自行推断。</p>
 */
export type BlockStatus = 'STREAMING' | 'DONE' | 'FAILED' | 'PROMISED' | 'REJECTED' | 'TIMED_OUT' | 'CANCELLED';

/**
 * 正文落点（仅 {@link TextBlock} 有意义）。
 *
 * <p>{@code BODY} = 本轮结论正文，{@code PROCESS} = 中途叙述（该模型响应还带工具请求）。
 * 判据由后端唯一确定，前端只据此决定渲染位置。</p>
 */
export type Placement = 'BODY' | 'PROCESS';

/** 所有块的公共字段（对应后端 {@code Block} 接口）。 */
export interface BlockBase {
  /**
   * 块身份，后端唯一确定：{@code thinking:<responseId>} / {@code text:<responseId>} /
   * {@code tool:<toolCallId>}；无 responseId 的旧数据退化为 {@code thinking|text:message:<行ID>}。
   *
   * <p>前端按它做 upsert 替换 —— 这是唯一的块身份，**不要再用内容指纹**。</p>
   */
  blockId: string;
  /** 判别式，与 {@link BlockType} 对齐 */
  type: BlockType;
  /** 产生该块的模型响应身份；工具块恒为 null */
  responseId?: string | null;
  /**
   * 块在本轮内的展示序号（升序排序键，后端给出）。
   * 布局：{@code responseOrder * 1000 + slot}（THINKING=0 / TEXT=1 / TOOL=2..）。
   */
  order: number;
  /** 块状态 */
  status: BlockStatus;
}

/** 思考块（对应后端 {@code ThinkingBlock}）。 */
export interface ThinkingBlock extends BlockBase {
  type: 'THINKING';
  /**
   * 思考正文。
   *
   * <p><b>字段名必须与后端一致（{@code text}）</b>：后端三个块 record 一律用
   * {@code @JsonProperty("text")} 序列化文本载荷。此处曾写作 {@code content}，
   * 于是运行时读到的永远是 {@code undefined} —— 而测试 fixture 也照抄了同一个错名，
   * 两边一起错、全绿通过，直到接通真实接口才暴露（投影后正文与思考全被清空）。</p>
   */
  text: string;
}

/** 正文块（对应后端 {@code TextBlock}）。 */
export interface TextBlock extends BlockBase {
  type: 'TEXT';
  /** 正文；字段名同 {@link ThinkingBlock.text}，必须与后端 {@code text} 对齐 */
  text: string;
  /** 落点：结论正文 or 中途叙述 */
  placement: Placement;
}

/** 工具块（对应后端 {@code ToolBlock}）。 */
export interface ToolBlock extends BlockBase {
  type: 'TOOL';
  /** 工具调用 id（{@code call_xxx}），与 {@code ToolCallVO.id} 同源 */
  toolCallId: string;
  /** 工具名（仅展示） */
  toolName: string;
  /** 调用参数（JSON 字符串） */
  arguments?: string | null;
  /** 输出载荷（JSON 字符串；结论在 outcome 里） */
  output?: string | null;
  /** 变更行数统计（文件类工具）；未知为 null */
  plusLines?: number | null;
  minusLines?: number | null;
}

/** 判别联合：拿到 {@code type} 即可安全收窄。 */
export type Block = ThinkingBlock | TextBlock | ToolBlock;

/**
 * 一轮的完整展示视图（对应后端 {@code TurnViewVO}）。
 *
 * <p><b>历史与实时共用</b>：历史查询以 {@code Map<turnId, TurnViewVO>} 随分页返回；
 * 实时以 {@code TURN_SNAPSHOT}（整轮）/ {@code BLOCK_UPSERT}（单块，blocks 只含变化块）下发。</p>
 */
export interface TurnViewVO {
  /** 块内容的**真实归属**会话（子会话即子会话自身；不是路由用的根会话） */
  sessionId: string;
  /** 业务轮次 id */
  turnId: string;
  /** 轮次状态（ACCEPTED/RUNNING/WAITING/COMPLETED/FAILED/CANCELLED） */
  status: string;
  /**
   * 该轮展示的更新批次号（单调不减）。
   *
   * <p>前端排序判据：{@code TURN_SNAPSHOT} 拿到**更小**的版本号即丢弃（乱序旧帧）。</p>
   * <p>⚠️ {@code BLOCK_UPSERT} 的版本号可能与前一次相等（工具收尾不改 chat_turn），
   * 因此**增量不做版本比较**，一律按 {@code blockId} 覆盖（天然幂等）。</p>
   */
  viewVersion: number;
  /** 该轮的用户提问；旧数据可能为 null */
  userMessage?: string | null;
  /** 块列表（已按 order 升序）；增量事件时只含变化的那一块 */
  blocks: Block[];
  /** 上下文用量快照；未配置上限或未采集为 null */
  metric?: ContextUsageVO | null;
}

/** 上下文用量（对应后端 {@code ContextUsageMetric}）。 */
export interface ContextUsageVO {
  tokenCount: number;
  maxTokens: number;
  ratio: number;
}

/* ------------------------------------------------------------------ */
/* SSE 业务事件载荷                                                      */
/* ------------------------------------------------------------------ */

/**
 * 业务事件载荷（对应后端 {@code BlockEventType.BlockEventPayload}）。
 *
 * <p>SSE 事件名（{@code event:} 行）就是 {@code TURN_SNAPSHOT} 或 {@code BLOCK_UPSERT}，
 * 事件体即本接口的 JSON。</p>
 */
export interface BlockEventPayload {
  /** 块内容的真实归属会话（与 {@code view.sessionId} 同值，冗余便于分派） */
  sessionId: string;
  /** 业务轮次 id */
  turnId: string;
  /** 该轮展示的更新批次号 */
  viewVersion: number;
  /** 该轮视图；{@code BLOCK_UPSERT} 时 {@code blocks} 只含变化的块 */
  view: TurnViewVO;
}

/** SSE 业务事件名（对应后端 {@code BlockEventType}）。 */
export const BlockEventName = {
  /** 整轮快照：前端按 viewVersion 整轮替换 */
  TURN_SNAPSHOT: 'TURN_SNAPSHOT',
  /** 单块增量：前端按 blockId upsert */
  BLOCK_UPSERT: 'BLOCK_UPSERT',
} as const;

export type BlockEventNameValue = (typeof BlockEventName)[keyof typeof BlockEventName];
