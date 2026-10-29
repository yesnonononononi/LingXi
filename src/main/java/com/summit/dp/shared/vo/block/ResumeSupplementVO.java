package com.summit.dp.shared.vo.block;

import java.time.Instant;

/** 补充属于原轮次，独立消息身份用于实时与历史去重。 */
public record ResumeSupplementVO(Long messageId, String text, Instant createdAt) { }
