package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolDefinition;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 启动期门禁：每个静态装配的 {@link ToolDefinition} 必须带一份能被 Jackson 解析的参数 JSON Schema。
 *
 * <p>为什么需要这道门禁：Schema 是写在 Java 文本块里的 JSON 原文，而文本块同样处理转义序列，
 * 一个 {@code \"} 就退化成裸引号。这类错误编译期毫无反应，直到模型请求组装时才炸在
 * {@code JsonSchemaConverter}，代价是整批工具一起不可用，而且报错只说「schema 非法」不说哪个工具。
 * 把它提前到启动期，并指名到具体工具。</p>
 *
 * <p>范围：只覆盖启动时静态装配的工具。MCP 工具按 scope 在运行时动态生成，没有静态 Schema 文本可校验。</p>
 */
@Slf4j
@Component
public class ToolDefinitionSchemaGate implements SmartInitializingSingleton {

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
        log.info("工具参数 Schema 门禁通过: 校验 {} 个工具", definitions.size());
        return violations;
    }

    private Map<String, ToolDefinition<?>> assembledDefinitions() {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        context.getBeansOfType(ToolDefinition.class).forEach(definitions::put);
        return definitions;
    }
}
