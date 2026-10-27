package com.summit.dp.checklist.domain.model;

import com.summit.dp.shared.exception.ClientException;

import java.time.Instant;
import java.util.List;

/**
 * 清单的领域约束常量与校验。
 *
 * <p>集中在一处的理由：工具 schema 的长度上限、服务层校验、提醒文案的条数上限必须同源，
 * 否则模型看到的上限会和实际校验不一致，报错文案也就不可信了。
 * 这些值同时被 {@code @StringValue(maxLength = ...)} 引用，因此必须是编译期常量。</p>
 */
public final class ChecklistRules {

    /** 清单标题最大长度：与 init.sql 的 checklist.title 列宽一致 */
    public static final int MAX_TITLE_LENGTH = 200;

    /** 单个步骤内容最大长度：与 init.sql 的 checklist_step.content 列宽一致 */
    public static final int MAX_STEP_CONTENT_LENGTH = 500;

    /** 至少一个步骤：空清单无法承载任何进展，只会白占唯一额度 */
    public static final int MIN_STEPS = 1;

    /** 最多步骤数：既是注意力预算，也是提醒文案的行数上限来源 */
    public static final int MAX_STEPS = 50;

    /** 提醒文案里最多列出的步骤条数，避免大清单挤占上下文 */
    public static final int MAX_REMIND_STEPS = 20;

    private ChecklistRules() {
    }

    /** 归一化标题：去首尾空白后校验非空与长度。 */
    public static String normalizeTitle(String title) {
        if (title == null || title.isBlank()) {
            throw new ClientException("清单标题不能为空");
        }
        String normalized = title.trim();
        if (normalized.length() > MAX_TITLE_LENGTH) {
            throw new ClientException("清单标题不能超过 " + MAX_TITLE_LENGTH + " 字符");
        }
        return normalized;
    }

    /** 归一化步骤内容：不允许空步骤，长度受同一常量约束。 */
    public static String normalizeStepContent(String content) {
        if (content == null || content.isBlank()) {
            throw new ClientException("步骤内容不能为空");
        }
        String normalized = content.trim();
        if (normalized.length() > MAX_STEP_CONTENT_LENGTH) {
            throw new ClientException("步骤内容不能超过 " + MAX_STEP_CONTENT_LENGTH + " 字符");
        }
        return normalized;
    }

    /** 归一化一组新建步骤内容，并校验数量上下限。 */
    public static List<String> normalizeStepContents(List<String> contents) {
        if (contents == null || contents.isEmpty()) {
            throw new ClientException("清单至少需要一个步骤");
        }
        if (contents.size() > MAX_STEPS) {
            throw new ClientException("清单步骤不能超过 " + MAX_STEPS + " 个");
        }
        return contents.stream().map(ChecklistRules::normalizeStepContent).toList();
    }

    /** 校验步骤总数不超过上限（新增步骤时使用）。 */
    public static void requireStepCount(int count) {
        if (count < MIN_STEPS) {
            throw new ClientException("清单至少需要一个步骤，不能删光");
        }
        if (count > MAX_STEPS) {
            throw new ClientException("清单步骤不能超过 " + MAX_STEPS + " 个");
        }
    }

    /** 解析模型下发的步骤状态文本；只接受三个终态取值，其余一律拒绝。 */
    public static ChecklistStepStatus parseStepStatus(String status) {
        if (status == null || status.isBlank()) {
            throw new ClientException("步骤状态不能为空，只接受 COMPLETED / FAILED / SKIPPED");
        }
        String normalized = status.trim().toUpperCase(java.util.Locale.ROOT);
        for (ChecklistStepStatus candidate : ChecklistStepStatus.values()) {
            if (candidate.isTerminal() && candidate.name().equals(normalized)) {
                return candidate;
            }
        }
        throw new ClientException("步骤状态 " + status + " 不合法，只接受 COMPLETED / FAILED / SKIPPED");
    }

    /** 统一的时间戳来源，便于测试观察「无变化不刷新时间」。 */
    static Instant now() {
        return Instant.now();
    }
}
