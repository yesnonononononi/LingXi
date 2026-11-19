package com.summit.dp.architecture;

import com.summit.dp.workflow.application.chat.ExecutionContext;
import com.summit.dp.workflow.application.chat.ResendSnapshot;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.RecordComponent;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link RuntimeContext} 的结构守卫：主构造只允许「身份 + 四个语义组」。
 *
 * <p><b>为什么要有这条用例</b>：它曾经是十四个平级组件，加「重发快照」时只能在末尾再追一个
 * 位置参数 —— 相邻的同类型参数（两个 ID、两个布尔、两段消息）填错一个，编译器一句话都不会说，
 * 运行期才在某个分支上炸。分组之后新增字段只能落在组内，主构造保持稳定。</p>
 *
 * <p>变异即可验证：往主构造里追一个平级字段，{@code mainConstructorKeepsFiveSemanticParts} 立刻变红。</p>
 */
class RuntimeContextShapeTest {

    /** 组内组件上限：超过说明这一组又开始长成「什么都往里塞」的杂物袋。 */
    private static final int MAX_GROUP_COMPONENTS = 4;

    @Test
    @DisplayName("主构造是身份 + 四个语义组，新增字段必须落进组内")
    void mainConstructorKeepsFiveSemanticParts() {
        RecordComponent[] parts = RuntimeContext.class.getRecordComponents();

        assertEquals(5, parts.length,
                "新增字段请放进现有的语义组，不要再往主构造追位置参数");
        assertEquals(ExecutionContext.class, parts[0].getType(), "第一项必须是执行身份");
        for (int index = 1; index < parts.length; index++) {
            Class<?> type = parts[index].getType();
            assertTrue(type.isRecord(), parts[index].getName() + " 应当是语义组（RuntimeContext 的嵌套 record）");
            assertEquals(RuntimeContext.class, type.getDeclaringClass(),
                    parts[index].getName() + " 应当是 RuntimeContext 自己的组，而不是外部类型");
            assertTrue(type.getRecordComponents().length <= MAX_GROUP_COMPONENTS,
                    parts[index].getName() + " 组内组件超过 " + MAX_GROUP_COMPONENTS + " 个，该拆了");
        }
    }

    @Test
    @DisplayName("重发快照属于上下文载荷，不是主构造项")
    void resendSnapshotLivesInThePayloadGroup() {
        RecordComponent inPayload = componentNamed(RuntimeContext.ContextPayload.class, "resendSnapshot");

        assertNotNull(inPayload, "载荷组必须承载重发快照");
        assertEquals(ResendSnapshot.class, inPayload.getType());
        assertNull(componentNamed(RuntimeContext.class, "resendSnapshot"),
                "重发快照只能挂在载荷组上，不能被提升成主构造字段");
    }

    private static RecordComponent componentNamed(Class<?> type, String name) {
        return Arrays.stream(type.getRecordComponents())
                .filter(component -> component.getName().equals(name))
                .findFirst().orElse(null);
    }
}
