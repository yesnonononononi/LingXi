package com.summit.dp.stream.application.protocol;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;

public record StreamSnapshot(String streamEpoch, String watermark, String historyRevision, Scope scope,
                             List<ObjectNode> sessions, List<ObjectNode> turns, List<ObjectNode> executions,
                             List<ObjectNode> messages, List<ObjectNode> toolCalls) {
    public record Scope(List<String> sessionIds, List<String> replaceTurnIds, List<String> retainedTurnIds,
                        boolean allUnresolvedToolsIncluded, boolean completeRootHistory) { }
}
