package com.summit.dp.agent.infrastructure.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.agent.domain.model.Agent;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.agent.infrastructure.persistence.mapper.AgentMapper;
import com.summit.dp.agent.infrastructure.persistence.po.AgentPO;
import lombok.extern.slf4j.Slf4j;
import org.jetbrains.annotations.NotNull;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Repository;

import java.util.Arrays;
import java.util.Collection;
import java.util.List;

/** Agent 仓储实现 */
@Repository
@Slf4j
public class AgentRepositoryImpl extends AbstractRepository<Agent, AgentPO, Long>
        implements AgentRepository {

    private static final String SEPARATOR = ",";

    private final AgentMapper mapper;
    private final ObjectMapper objectMapper;

    public AgentRepositoryImpl(AgentMapper mapper, ObjectMapper objectMapper) {
        this.mapper = mapper;
        this.objectMapper = objectMapper;
    }

    @Override
    protected @NotNull BaseMapper<AgentPO> mapper() {
        return this.mapper;
    }

    @Override
    public Collection<Agent> findList(Collection<Long> ids) {
        return super.findList(ids);
    }

    @Override
    protected Agent toModel(AgentPO po) {
        return Agent.builder()
                .id(po.getId())
                .name(po.getName())
                .modelId(po.getModelId())
                .toolList(parseToolList(po.getToolList()))
                .prompt(po.getPrompt())
                .description(po.getDescription())
                .status(po.getStatus())
                .build();
    }

    @Override
    protected AgentPO toPO(Agent model) {
       return AgentPO.builder()
               .id(model.getId())
               .name(model.getName())
               .modelId(model.getModelId())
               .toolList(writeToolList(model.getToolList()))
               .prompt(model.getPrompt())
               .description(model.getDescription())
               .status(model.getStatus())
               .build();
    }

    private List<String> parseToolList(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        String trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
            try {
                return objectMapper.readValue(trimmed, new TypeReference<List<String>>() {
                });
            } catch (Exception e) {
                log.warn("工具列表不是合法 JSON，回退为逗号分隔解析: {}", trimmed);
            }
        }
        return Arrays.stream(trimmed.split(SEPARATOR))
                .map(String::trim)
                .filter(tool -> !tool.isEmpty())
                .toList();
    }

    private String writeToolList(List<String> toolList) {
        if (toolList == null || toolList.isEmpty()) return null;
        List<String> tools = toolList.stream()
                .filter(tool -> tool != null && !tool.isBlank())
                .map(String::trim)
                .toList();
        if (tools.isEmpty()) return null;
        try {
            return objectMapper.writeValueAsString(tools);
        } catch (Exception e) {
            log.warn("工具列表序列化失败，回退为逗号分隔: {}", tools);
            return String.join(SEPARATOR, tools);
        }
    }
}
