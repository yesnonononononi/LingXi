package com.summit.dp.stream.application.protocol;

import cn.hutool.core.util.IdUtil;
import com.fasterxml.jackson.databind.JsonNode;

/** eventId 在创建时固定，多连接分发和同一操作重试共用身份。 */
public record StreamOperation(String eventId, String sessionId, String turnId, String executionId,
                              String historyRevision, String type, JsonNode payload) {
    public static StreamOperation create(String sessionId, String turnId, String executionId,
                                         String revision, String type, JsonNode payload) {
        return new StreamOperation(String.valueOf(IdUtil.getSnowflakeNextId()), sessionId, turnId,
                executionId, revision, type, payload.deepCopy());
    }
}
