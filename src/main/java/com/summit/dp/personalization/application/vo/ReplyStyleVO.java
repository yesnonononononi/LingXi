package com.summit.dp.personalization.application.vo;

/** 风格提交值与展示文案一起下发，避免前端按中文反推枚举。 */
public record ReplyStyleVO(String value, String label) {}
