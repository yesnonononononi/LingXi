package com.summit.dp.execution;

import com.summit.dp.execution.domain.model.ResumeSource;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 应用层策略枚举 ↔ 领域层持久化枚举的映射必须一一对应。
 *
 * <p><b>为什么单独守</b>：两个枚举是刻意分开的（领域层不能反向依赖应用层），代价是可能出现
 * 「新增一个触发来源却忘了映射」。这条用例让那种情况立刻变红，而不是在线上表现为
 * 「来源被静默按自动唤醒处理」。</p>
 */
class ResumeTriggerSourceMappingTest {

    @Test
    @DisplayName("每个触发来源都有持久化口径，且可原路映射回来")
    void everyTriggerRoundTrips() {
        Set<String> persistedValues = new LinkedHashSet<>();
        for (ResumeTriggerType trigger : ResumeTriggerType.values()) {
            ResumeSource source = trigger.persisted();
            assertNotNull(source, "触发来源缺少持久化口径: " + trigger);
            assertEquals(trigger, ResumeTriggerType.of(source),
                    "持久化口径映射回来必须还是同一个来源: " + trigger);
            assertTrue(persistedValues.add(source.dbValue()),
                    "两个触发来源不能落到同一个持久化值上: " + source.dbValue());
            assertEquals(trigger.humanInitiated(), source.humanInitiated(),
                    "「是否人工发起」两边必须一致，否则门禁口径会与来源不符: " + trigger);
        }
        assertEquals(ResumeTriggerType.values().length, persistedValues.size(),
                "持久化值必须与触发来源一一对应（不得复用、不得缺项）");
    }

    @Test
    @DisplayName("遗留行（来源为 NULL）按自动唤醒处理")
    void legacyNullSourceFallsBackToAutoWakeup() {
        assertEquals(ResumeTriggerType.AUTO_INPUT_WAKEUP, ResumeTriggerType.of(null));
    }
}
