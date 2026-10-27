package com.summit.dp.checklist.application;

import java.util.Set;

/** 投递证据来自执行检查点，不能把占用额度等同于模型已经收到提醒。 */
public record ChecklistReminderContext(long sessionId, Long executionId, Set<String> deliveredMarkers) {
    public ChecklistReminderContext {
        deliveredMarkers = deliveredMarkers == null ? Set.of() : Set.copyOf(deliveredMarkers);
    }

    public boolean wasDelivered(long checklistId, long progressVersion) {
        return executionId != null && deliveredMarkers.contains(buildDeliveryMarker(checklistId, progressVersion, executionId));
    }

    public static String buildDeliveryMarker(long checklistId, long progressVersion, long executionId) {
        return "[lingxi-checklist-reminder:" + checklistId + ":" + progressVersion + ":" + executionId + "]";
    }
}
