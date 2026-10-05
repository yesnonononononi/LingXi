package com.summit.dp.stream.application.protocol;

import com.fasterxml.jackson.databind.node.ObjectNode;

/** 窗口外卡片只能补持久化内容，不能覆盖实时动作。 */
public record StreamToolProjection(int schemaVersion, String streamEpoch, String watermark,
                                   String historyRevision, boolean persistentOnly, ObjectNode toolCall) { }
