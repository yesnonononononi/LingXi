package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import cn.hutool.crypto.digest.DigestUtil;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.ArrayList;

/** 只归并当前事实，不记录通知，也不改变执行状态。 */
@Component
@RequiredArgsConstructor
public class InputResolver {
    private final List<InputSource<?>> sources;
    private final ObjectMapper json;

    public String pendingBatchKey(Execution execution) {
        try {
            List<String> batches = new ArrayList<>();
            for (InputSource<?> source : sources) {
                List<?> items = source.pendingItems(execution);
                if (!items.isEmpty()) batches.add(source.getClass().getName() + ":" + json.writeValueAsString(items));
            }
            return batches.isEmpty() ? null : DigestUtil.sha256Hex(String.join("\n", batches));
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException("待处理输入无法生成批次标识", failure);
        }
    }

    public boolean hasPendingItems(Execution execution) {
        return sources.stream().anyMatch(source -> !source.pendingItems(execution).isEmpty());
    }

    public boolean hasOpenDependency(Execution execution) {
        return sources.stream().anyMatch(source -> source.hasOpenDependency(execution));
    }
}
