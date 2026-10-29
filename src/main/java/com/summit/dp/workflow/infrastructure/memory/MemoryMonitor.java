package com.summit.dp.workflow.infrastructure.memory;

import com.summit.core.adapter.TokenEstimator;
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

/** 容量按 token 估算，项目记忆只能从执行绑定的工作区定位。 */
@Slf4j
@Component
public class MemoryMonitor {
    static final String REMINDER_PREFIX = "【长期记忆容量提醒】";

    private final TokenEstimator tokenEstimator;
    private final String globalLocation;
    private final long globalMaxTokens;
    private final String projectRelativeLocation;
    private final long projectMaxTokens;

    public MemoryMonitor(TokenEstimator tokenEstimator,
                         @Value("${lingxi.memory.global.location}") String globalLocation,
                         @Value("${lingxi.memory.global.max-tokens}") long globalMaxTokens,
                         @Value("${lingxi.memory.project.relative-location}") String projectRelativeLocation,
                         @Value("${lingxi.memory.project.max-tokens}") long projectMaxTokens) {
        this.tokenEstimator = tokenEstimator;
        this.globalLocation = globalLocation;
        this.globalMaxTokens = globalMaxTokens;
        this.projectRelativeLocation = projectRelativeLocation;
        this.projectMaxTokens = projectMaxTokens;
    }

    public List<SystemMessageEntity> checkMemoryLimits(String workDir) {
        List<SystemMessageEntity> reminders = new ArrayList<>();
        if (projectMaxTokens > 0 && workDir != null && !workDir.isBlank()
                && projectRelativeLocation != null && !projectRelativeLocation.isBlank()) {
            try {
                Path root = Path.of(workDir).normalize();
                Path relative = Path.of(projectRelativeLocation);
                Path memory = root.resolve(relative).normalize();
                // 缺少绝对工作区或配置越界时不能回落到进程目录，避免整理错项目。
                if (root.isAbsolute() && !relative.isAbsolute() && memory.startsWith(root)) {
                    appendReminder(reminders, memory, "项目", projectMaxTokens);
                } else {
                    log.warn("跳过项目记忆检查: workDir={}, relativeLocation={}", workDir, projectRelativeLocation);
                }
            } catch (InvalidPathException error) {
                log.warn("项目记忆路径无效: workDir={}, relativeLocation={}", workDir, projectRelativeLocation, error);
            }
        }
        if (globalMaxTokens > 0 && globalLocation != null && !globalLocation.isBlank()) {
            try {
                appendReminder(reminders, Path.of(globalLocation).toAbsolutePath().normalize(), "全局", globalMaxTokens);
            } catch (InvalidPathException error) {
                log.warn("全局记忆路径无效: location={}", globalLocation, error);
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
