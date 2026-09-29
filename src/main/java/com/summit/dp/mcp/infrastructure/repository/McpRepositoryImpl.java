package com.summit.dp.mcp.infrastructure.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.persistence.mapper.McpMapper;
import com.summit.dp.mcp.infrastructure.persistence.po.McpPO;
import lombok.extern.slf4j.Slf4j;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.time.Duration;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Mcp 仓储实现。
 *
 * <p>承接四处形态转换，均收口在本层，领域侧不感知存储细节：</p>
 * <ul>
 *   <li>{@code headers} / {@code env}：JSON 字符串 ⇄ {@code Map<String,String>}；</li>
 *   <li>{@code command}：JSON 数组字符串 ⇄ {@code List<String>}；</li>
 *   <li>超时：毫秒 {@code Long} ⇄ {@link Duration}；</li>
 *   <li>时间列名差异：领域 {@code createAt/updateAt} ⇄ 库 {@code createTime/updateTime}。</li>
 * </ul>
 */
@Repository
@Slf4j
public class McpRepositoryImpl extends AbstractRepository<Mcp, McpPO, Long>
        implements McpRepository {

    private final McpMapper mapper;
    private final ObjectMapper objectMapper;

    public McpRepositoryImpl(McpMapper mapper, ObjectMapper objectMapper) {
        this.mapper = mapper;
        this.objectMapper = objectMapper;
    }

    @Override
    protected @NotNull BaseMapper<McpPO> mapper() {
        return this.mapper;
    }

    @Override
    public Collection<Mcp> findList(Collection<Long> ids) {
        return super.findList(ids);
    }

    @Override
    public Optional<Mcp> findByName(String name) {
        if (name == null || name.isBlank()) return Optional.empty();
        // 重名校验的过滤条件下推到 SQL，不捞全表后比较
        List<McpPO> found = mapper.selectList(new LambdaQueryWrapper<McpPO>()
                .eq(McpPO::getName, name.trim())
                .last("LIMIT 1"));
        return found.isEmpty() ? Optional.empty() : Optional.of(toModel(found.getFirst()));
    }

    @Override
    public List<Mcp> findEnabled() {
        return mapper.selectList(new LambdaQueryWrapper<McpPO>()
                        .eq(McpPO::getStatus, Mcp.STATUS_ENABLED)
                        .orderByAsc(McpPO::getId))
                .stream()
                .map(this::toModel)
                .toList();
    }

    @Override
    protected Mcp toModel(McpPO po) {
        return Mcp.builder()
                .id(po.getId())
                .name(po.getName())
                .transport(po.getTransport())
                .url(po.getUrl())
                .headers(parseStringMap(po.getHeaders()))
                .command(parseCommand(po.getCommand()))
                .env(parseStringMap(po.getEnv()))
                .toolNamePrefix(po.getToolNamePrefix())
                .initializationTimeout(toDuration(po.getInitializationTimeout(), Mcp.DEFAULT_INITIALIZATION_TIMEOUT))
                .executionTimeout(toDuration(po.getExecutionTimeout(), Mcp.DEFAULT_EXECUTION_TIMEOUT))
                .maxOutput(po.getMaxOutput() == null ? Mcp.DEFAULT_MAX_OUTPUT : po.getMaxOutput())
                .status(po.getStatus())
                .createAt(po.getCreateTime())
                .updateAt(po.getUpdateTime())
                .build();
    }

    @Override
    protected McpPO toPO(Mcp model) {
        return McpPO.builder()
                .id(model.getId())
                .name(model.getName())
                .transport(model.getTransport())
                .url(model.getUrl())
                .headers(writeStringMap(model.getHeaders()))
                .command(writeCommand(model.getCommand()))
                .env(writeStringMap(model.getEnv()))
                .toolNamePrefix(model.getToolNamePrefix())
                .initializationTimeout(model.getInitializationTimeout() == null
                        ? null : model.getInitializationTimeout().toMillis())
                .executionTimeout(model.getExecutionTimeout() == null
                        ? null : model.getExecutionTimeout().toMillis())
                .maxOutput(model.getMaxOutput())
                .status(model.getStatus())
                .createTime(model.getCreateAt())
                .updateTime(model.getUpdateAt())
                .build();
    }

    /** 解析 JSON 键值对（headers/env）；非法内容按空表处理并告警，不让单行脏数据拖垮整个装配 */
    private Map<String, String> parseStringMap(String raw) {
        if (raw == null || raw.isBlank()) return Map.of();
        try {
            Map<String, String> map = objectMapper.readValue(raw, new TypeReference<Map<String, String>>() {
            });
            return map == null ? Map.of() : map;
        } catch (Exception e) {
            log.warn("MCP JSON 键值对不是合法 JSON 对象，按空表处理: {}", raw);
            return Map.of();
        }
    }

    /** 解析 stdio 启动命令 JSON 数组；非法内容按空列表处理并告警 */
    private List<String> parseCommand(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        try {
            List<String> command = objectMapper.readValue(raw, new TypeReference<List<String>>() {
            });
            return command == null ? List.of() : command;
        } catch (Exception e) {
            log.warn("MCP command 不是合法 JSON 数组，按空列表处理: {}", raw);
            return List.of();
        }
    }

    private String writeStringMap(Map<String, String> map) {
        if (map == null || map.isEmpty()) return null;
        try {
            return objectMapper.writeValueAsString(map);
        } catch (Exception e) {
            log.warn("MCP JSON 键值对序列化失败，按空处理: {}", map);
            return null;
        }
    }

    private String writeCommand(List<String> command) {
        if (command == null || command.isEmpty()) return null;
        try {
            return objectMapper.writeValueAsString(command);
        } catch (Exception e) {
            log.warn("MCP command 序列化失败，按空处理: {}", command);
            return null;
        }
    }

    private Duration toDuration(Long millis, Duration fallback) {
        return millis == null || millis <= 0 ? fallback : Duration.ofMillis(millis);
    }
}
