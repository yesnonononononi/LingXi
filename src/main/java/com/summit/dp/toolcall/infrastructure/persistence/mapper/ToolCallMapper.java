package com.summit.dp.toolcall.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

import java.util.Map;

/** {@code tool_call} 表 Mapper。 */
@Mapper
public interface ToolCallMapper extends BaseMapper<ToolCallPO> {

    /**
     * 批量回填消息锚点：一条 UPDATE 绑定多个工具调用。
     *
     * <p><b>为什么用 {@code CASE id WHEN ...} 而不是领域方法/updateById</b>：锚点回填只改一列，
     * 走实体更新要先读 4 个 CLOB 再整行写回，一次绑定就变成「4 次 CLOB 读 + 4 次临时 LOB 写」；
     * 而且批量场景下逐行 {@code updateById} 是 N 条语句。这里保留原窄更新的语义：
     * 只更新 {@code session_message_id} 为空或与目标值不同的行，并 {@code version = version + 1}
     * —— 其他持有旧模型的写入方靠版本条件失败来发现冲突，漏掉自增就会让旧的 {@code updateById}
     * 把锚点抹掉。重复绑定同一消息不会产生实际变更。</p>
     *
     * @param bindings 工具调用 ID → 消息 ID；调用方保证非空
     * @return 实际更新的行数（无需更新时为 0）
     */
    @Update("<script>"
            + "UPDATE tool_call SET session_message_id = CASE id "
            + "<foreach collection='bindings' index='toolCallId' item='messageId'>"
            + " WHEN #{toolCallId} THEN #{messageId}"
            + "</foreach>"
            + " ELSE session_message_id END, version = version + 1 WHERE id IN ("
            + "<foreach collection='bindings' index='toolCallId' item='messageId' separator=','>"
            + "#{toolCallId}"
            + "</foreach>"
            + ") AND (session_message_id IS NULL OR session_message_id &lt;&gt; CASE id "
            + "<foreach collection='bindings' index='toolCallId' item='messageId'>"
            + " WHEN #{toolCallId} THEN #{messageId}"
            + "</foreach>"
            + " ELSE session_message_id END)"
            + "</script>")
    int bindSessionMessagesBatch(@Param("bindings") Map<String, Long> bindings);
}
