package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolRegistry;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.ApplicationContext;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 注解工具稍晚于普通 Bean 入表，门禁必须在注册器之后再次核验完整注册表。
 */
@Slf4j
@Component
@Order(1000)
public class ToolDefinitionSchemaGate implements SmartInitializingSingleton, ApplicationRunner {

    private final ApplicationContext context;
    private final ObjectMapper objectMapper;

    public ToolDefinitionSchemaGate(ApplicationContext context, ObjectMapper objectMapper) {
        this.context = context;
        this.objectMapper = objectMapper;
    }

    @Override
    public void afterSingletonsInstantiated() {
        check(assembledDefinitions());
    }

    @Override
    public void run(ApplicationArguments args) {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        context.getBean(ToolRegistry.class).getTools().forEach(definitions::put);
        check(definitions);
    }

    /**
     * 校验给定工具定义，违规即抛异常；返回空列表表示全部通过。
     *
     * <p>对外暴露是为了让测试能塞进一个故意写坏的定义，证明门禁真的会拦——只断言「现有工具都通过」
     * 的门禁，在自己被改成永远通过时同样是绿的。</p>
     */
    public List<String> check(Map<String, ToolDefinition<?>> definitions) {
        List<String> violations = new ArrayList<>();
        definitions.forEach((beanName, definition) -> {
            if (definition == null) {
                violations.add(beanName + " 是 null");
                return;
            }
            String name = definition.name() == null ? beanName : definition.name();
            String schema = definition.parametersJsonSchema();
            if (schema == null || schema.isBlank()) {
                violations.add(name + "（bean: " + beanName + "）没有参数 Schema");
                return;
            }
            try {
                JsonNode root = objectMapper.readTree(schema);
                if (root == null || !root.isObject()) {
                    violations.add(name + "（bean: " + beanName + "）参数 Schema 不是 JSON 对象");
                }
            } catch (JsonProcessingException e) {
                violations.add(name + "（bean: " + beanName + "）参数 Schema 不是合法 JSON：" + e.getOriginalMessage()
                        + "；提示：文本块会处理转义序列，JSON 字符串里的引号必须写成转义形式，最好干脆不在 Schema 里写引号");
            } catch (Exception e) {
                violations.add(name + "（bean: " + beanName + "）参数 Schema 无法解析：" + e);
            }
        });
        if (!violations.isEmpty()) {
            throw new IllegalStateException("工具参数 Schema 门禁未通过，包含这些工具的模型请求将无法组装: " + violations);
        }
        log.info("工具参数 Schema 门禁通过: count={}", definitions.size());
        return violations;
    }

    private Map<String, ToolDefinition<?>> assembledDefinitions() {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        context.getBeansOfType(ToolDefinition.class).forEach(definitions::put);
        return definitions;
    }
}
