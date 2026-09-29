package com.summit.dp.execution;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 受控属性统一解析函数的回归：属性值形态（String / 数值 / 脏值）与协作根执行 ID 的推导规则。
 *
 * <p>这些规则是邮箱业务键 {@code (workflowExecutionId, recipientAgentId)} 的唯一来源——
 * 发信工具与循环拦截器都靠它算出同一个 {@code workflowExecutionId}，
 * 因此根执行与子执行必须得到相同结果。</p>
 */
class ExecutionAttributesResolutionTest {

    @Test
    @DisplayName("readLong：String / 数值 / 空白 / 脏值 / 缺失 的解析边界")
    void readLongParsesStringAndNumericValues() {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put("string", "900");
        attributes.put("long", 900L);
        attributes.put("int", 900);
        attributes.put("blank", "   ");
        attributes.put("garbage", "not-a-number");
        attributes.put("nullValue", null);

        assertEquals(900L, ExecutionAttributes.readLong(attributes, "string"), "业务侧写入的是字符串");
        assertEquals(900L, ExecutionAttributes.readLong(attributes, "long"));
        assertEquals(900L, ExecutionAttributes.readLong(attributes, "int"));
        assertNull(ExecutionAttributes.readLong(attributes, "blank"));
        assertNull(ExecutionAttributes.readLong(attributes, "garbage"));
        assertNull(ExecutionAttributes.readLong(attributes, "nullValue"));
        assertNull(ExecutionAttributes.readLong(attributes, "missing"));
        assertNull(ExecutionAttributes.readLong(null, "string"));
        assertNull(ExecutionAttributes.readLong(attributes, null));
    }

    @Test
    @DisplayName("workflowExecutionId：根执行取自身执行 ID，子执行取 ROOT_EXECUTION_ID，两者结果相同")
    void workflowExecutionIdIsSharedByRootAndChild() {
        Map<String, Object> rootAttributes = Map.of(ExecutionAttributes.AGENT_ID, "7");
        assertEquals(900L, ExecutionAttributes.workflowExecutionId(rootAttributes, "900"),
                "根执行没有 ROOT_EXECUTION_ID 属性（ExecutionContext.root 的该字段为 null），取自身 executionId");

        Map<String, Object> childAttributes = Map.of(
                ExecutionAttributes.AGENT_ID, "8",
                ExecutionAttributes.ROOT_EXECUTION_ID, "900");
        assertEquals(900L, ExecutionAttributes.workflowExecutionId(childAttributes, "1234"),
                "子执行继承根执行 ID，与根执行算出同一个值");

        assertEquals(900L, ExecutionAttributes.workflowExecutionId(
                        Map.of(ExecutionAttributes.ROOT_EXECUTION_ID, 900L), "1234"),
                "数值形态的 ROOT_EXECUTION_ID（执行快照 JSON 往返后）同样可解析");
    }

    @Test
    @DisplayName("workflowExecutionId：属性与当前执行 ID 都不可解析时返回 null，不抛异常")
    void workflowExecutionIdReturnsNullWhenUnresolvable() {
        assertNull(ExecutionAttributes.workflowExecutionId(Map.of(), null));
        assertNull(ExecutionAttributes.workflowExecutionId(Map.of(), "   "));
        assertNull(ExecutionAttributes.workflowExecutionId(Map.of(), "abc"));
    }
}
