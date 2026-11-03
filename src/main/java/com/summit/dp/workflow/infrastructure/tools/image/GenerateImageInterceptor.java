package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** 外部调用前先保存配额，暂停恢复和失败重试也不能重置次数。 */
@Component
@RequiredArgsConstructor
public class GenerateImageInterceptor implements LoopInterceptor {
    static final String MODEL = "lingxi.generateImage.modelId";
    static final String LIMIT = "lingxi.generateImage.limit";
    static final String USED = "lingxi.generateImage.used";
    static final String ALLOWED = "lingxi.generateImage.allowed";
    static final String USAGE = "imageGenerationUsage";
    private final SettingsProvider settings;
    private final ExecutionRepository executions;
    private final ObjectMapper mapper;

    @Override public int order() { return -740; }
    @Override public boolean catchErr() { return false; }

    @Override
    public InterceptorResult onBeforeToolCall(LoopContext context) {
        List<ToolCallRequest> requests = context.getLoopMessages().getResponse().getAiMessageEntity().getToolCalls();
        if (requests == null || requests.stream().noneMatch(call -> ToolCatalog.GENERATE_IMAGE.equals(call.name()))) {
            return InterceptorResult.NONE;
        }
        Execution execution = context.getLoopMessages().getExecution();
        ImageExecutionAttributes.mutate(execution, attributes -> {
            if (!attributes.containsKey(LIMIT)) {
                SettingsView config = settings.current().orElse(null);
                if (config != null && config.imageModelId() != null) attributes.put(MODEL, config.imageModelId());
                attributes.put(LIMIT, config == null || config.imageGenerationMaxCalls() == null ? 0 : config.imageGenerationMaxCalls());
            }
            int used = ImageExecutionAttributes.number(attributes, USED);
            int limit = ImageExecutionAttributes.number(attributes, LIMIT);
            List<String> allowed = new ArrayList<>();
            for (ToolCallRequest request : requests) {
                if (ToolCatalog.GENERATE_IMAGE.equals(request.name()) && used < limit && attributes.containsKey(MODEL)) {
                    allowed.add(request.id());
                    used++;
                }
            }
            attributes.put(USED, used);
            attributes.put(ALLOWED, List.copyOf(allowed));
        });
        executions.save(execution);
        return InterceptorResult.NONE;
    }

    @Override
    public InterceptorResult onAfterToolCall(LoopContext context, List<ToolExecuteResult> results) {
        Execution execution = context.getLoopMessages().getExecution();
        for (ToolExecuteResult result : results) {
            if (result == null || result.getToolSpecification() == null
                    || !ToolCatalog.GENERATE_IMAGE.equals(result.getToolSpecification().name())
                    || result.getToolMetaData() == null || !result.getToolMetaData().containsKey(USAGE)) continue;
            TokenUsageEntity usage = mapper.convertValue(result.getToolMetaData().get(USAGE), TokenUsageEntity.class);
            if (execution.getTokenUsage() == null) execution.setTokenUsage(TokenUsageEntity.empty());
            execution.getTokenUsage().add(usage);
        }
        return InterceptorResult.NONE;
    }

    /** 整数属性读取，缺失按 0：这是配额断言的统一读取口径，测试直接调它，别当死代码删。 */
    static int number(Map<String, Object> attributes, String key) {
        return ImageExecutionAttributes.number(attributes, key);
    }
}
