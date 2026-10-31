package com.summit.dp.toolcall.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.summit.dp.shared.persistence.handler.LargeTextTypeHandler;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.apache.ibatis.type.JdbcType;

import java.time.Instant;

/**
 * {@code tool_call} 表持久化对象：一条记录 = 一次工具调用的状态与卡片载荷。
 *
 * <p>替换旧的 {@code interaction_status}：{@code type} / {@code status} 由数值码改为语义码
 * （VARCHAR）；{@code content}/{@code raw_input}/{@code raw_output}/{@code meta_data} 为 JSON 文本。</p>
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("tool_call")
public class ToolCallPO {

    /** 主键：模型下发的 call id（{@code call_xxx}），非自增，必须显式赋值。 */
    @TableId(type = IdType.INPUT)
    private String id;

    /** 所属会话（= session.id）。 */
    private Long conversationId;

    /** 回指承载该调用的 session_message.id（TOOL 行）；可空。 */
    private Long sessionMessageId;

    /** 派生此次调用的执行 ID。 */
    private Long executionId;

    private String toolName;

    /** PROMISE / EXECUTE。 */
    private String type;

    /** pending / in_progress / completed。 */
    private String status;

    private String title;

    /** 工具卡片载荷（JSON 文本）：可能含整段文件内容，H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String content;

    /** 原始入参（JSON 文本）：可能含整段文件内容，H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String rawInput;

    /** 原始出参（JSON 文本）：可能含命令输出全文，H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String rawOutput;

    /** 附加元数据（JSON 文本）：H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String metaData;

    /** 落定本结论的决策命令 ID；决策重试据此返回首次结论。 */
    private String decisionCommandId;

    /** 决策请求摘要；同 commandId 但内容不同即拒绝。 */
    private String decisionDigest;

    private Long version;

    private Instant createdAt;

    private Instant updatedAt;
}
