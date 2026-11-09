package com.summit.dp.device.domain;

import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DangerPolicyTest {

    private final DangerPolicy policy = new DangerPolicy();

    @Test
    void 文本命中危险关键词判高危() {
        Optional<DangerVerdict> verdict = policy.inspect("com.example.app", "确认转账 500 元", "tap");

        assertTrue(verdict.isPresent());
        assertEquals(DangerVerdict.Risk.HIGH, verdict.get().risk());
        assertTrue(verdict.get().reason().contains("转账"), "原因要写清命中了哪个词，否则用户无法判断");
    }

    @Test
    void 高敏应用内操作判中危() {
        Optional<DangerVerdict> verdict = policy.inspect("com.tencent.mm", "发送", "tap");

        assertTrue(verdict.isPresent());
        assertEquals(DangerVerdict.Risk.MEDIUM, verdict.get().risk());
    }

    @Test
    void 普通应用普通文本放行() {
        Optional<DangerVerdict> verdict = policy.inspect("com.example.notes", "保存笔记", "tap");

        assertTrue(verdict.isEmpty(), "不该对所有动作都弹确认，否则用户会习惯性点同意");
    }

    @Test
    void 文本高危优先于应用中危() {
        Optional<DangerVerdict> verdict = policy.inspect("com.tencent.mm", "删除聊天记录", "tap");

        assertTrue(verdict.isPresent());
        assertEquals(DangerVerdict.Risk.HIGH, verdict.get().risk(), "取最严结论");
    }

    @Test
    void 包名大小写与空白不影响判定() {
        Optional<DangerVerdict> verdict = policy.inspect("  COM.TENCENT.MM  ", null, "tap");

        assertTrue(verdict.isPresent(), "包名比较必须归一化，否则一个空格就能绕过策略");
    }
}
