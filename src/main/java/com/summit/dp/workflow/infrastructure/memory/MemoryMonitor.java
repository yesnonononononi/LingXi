package com.summit.dp.workflow.infrastructure.memory;

import com.summit.core.compact.TokenEstimator;
import com.summit.core.conversation.message.SystemMessageEntity;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** 用户级记忆保留容量提醒，项目 wiki 通过有界目录和按需读取控制上下文。 */
@Slf4j
@Component
public class MemoryMonitor {
    static final String REMINDER_PREFIX = "【长期记忆容量提醒】";

    private final TokenEstimator tokenEstimator;
    private final String userLocation;
    private final long userMaxTokens;

    public MemoryMonitor(TokenEstimator tokenEstimator,
                         @Value("${lingxi.memory.user.location}") String userLocation,
                         @Value("${lingxi.memory.user.max-tokens}") long userMaxTokens) {
        this.tokenEstimator = tokenEstimator;
        this.userLocation = userLocation;
        this.userMaxTokens = userMaxTokens;
    }

    public List<SystemMessageEntity> checkMemoryLimits() {
        List<SystemMessageEntity> reminders = new ArrayList<>();
        if (userMaxTokens > 0 && userLocation != null && !userLocation.isBlank()) {
            try {
                appendReminder(reminders, Path.of(userLocation).toAbsolutePath().normalize(), "用户", userMaxTokens);
            } catch (InvalidPathException error) {
                log.warn("用户记忆路径无效: location={}", userLocation, error);
            }
        }
        return List.copyOf(reminders);
    }

    private void appendReminder(List<SystemMessageEntity> reminders, Path memory, String scope, long maxTokens) {
        if (!Files.isRegularFile(memory)) return;
        try {
            int tokens = tokenEstimator.estimateText(Files.readString(memory));
            if (tokens > maxTokens) {
                reminders.add(SystemMessageEntity.builder().text(REMINDER_PREFIX + "\n"
                        + scope + "长期记忆文件：" + memory + "\n"
                        + "当前估算 " + tokens + " token，上限 " + maxTokens + " token。"
                        + "请读取并压缩该文件，合并重复内容、清理失效信息，保留有效约定与已验证事实，"
                        + "使长期记忆不超过上限后继续当前任务。").build());
            }
        } catch (IOException error) {
            // 检查不消费业务数据，读取失败只告警，不能阻断用户当前任务。
            log.warn("读取长期记忆失败: scope={}, path={}", scope, memory, error);
        }
    }
}
