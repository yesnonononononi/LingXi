package com.summit.dp.mcp.infrastructure.repository;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.persistence.mapper.McpMapper;
import com.summit.dp.mcp.infrastructure.persistence.po.McpPO;
import com.summit.ddd.infrastructure.repository.yaml.AbstractYamlRepository;
import com.summit.ddd.infrastructure.repository.yaml.YamlListStore;
import com.summit.dp.shared.utils.YamlSerializer;

import lombok.extern.slf4j.Slf4j;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;

import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/** 沿用既有 PO 字段，首次从 H2 迁移后以 YAML 为准。 */
@Repository
@Slf4j
public class McpRepositoryImpl extends AbstractYamlRepository<Mcp, McpPO>
        implements McpRepository {

    private final ObjectMapper objectMapper;

    public McpRepositoryImpl(McpMapper mapper, ObjectMapper objectMapper, YamlSerializer serializer,
                             @Value("${lingxi.config.mcp.path:${user.home}/.lingxi/config/mcp.yaml}") String path) {
        super(new YamlListStore<>(Path.of(path), serializer.listCodec(new TypeReference<List<McpPO>>() {}),
                () -> mapper.selectList(null)));
        this.objectMapper = objectMapper;
    }

    @Override
    protected Long resolveId(McpPO po) { return po.getId(); }

    @Override
    protected McpPO prepareInsert(McpPO po, long id) {
        Instant now = Instant.now();
        return po.toBuilder()
                .id(id)
                .createTime(po.getCreateTime() == null ? now : po.getCreateTime())
                .updateTime(now).build();
    }

    @Override
    protected McpPO prepareUpdate(McpPO previous, McpPO replacement) {
        return replacement.toBuilder().createTime(previous.getCreateTime()).updateTime(Instant.now()).build();
    }

    @Override
    public Collection<Mcp> findList(Collection<Long> ids) {
        return super.findList(ids);
    }

    @Override
    public Optional<Mcp> findByName(String name) {
        if (name == null || name.isBlank()) return Optional.empty();
        return store.access(false, records -> records.stream()
                .filter(po -> name.trim().equals(po.getName())).findFirst().map(this::toModel));
    }

    @Override
    public List<Mcp> findEnabled() {
        return store.access(false, records -> records.stream()
                .filter(po -> Objects.equals(po.getStatus(), Mcp.STATUS_ENABLED))
                .sorted(Comparator.comparing(McpPO::getId)).map(this::toModel).toList());
    }

    @Override
    protected Mcp toModel(McpPO po) {
        return Mcp.builder()
                .id(po.getId())
                .name(po.getName())
                .transport(Mcp.Transport.parse(po.getTransport()))
                .url(po.getUrl())
                .headers(parseStringMap(po.getHeaders()))
                .command(parseCommand(po.getCommand()))
                .env(parseStringMap(po.getEnv()))
                .description(po.getDescription())
                .initializationTimeout(toDuration(po.getInitializationTimeout(), Mcp.DEFAULT_INITIALIZATION_TIMEOUT))
                .executionTimeout(toDuration(po.getExecutionTimeout(), Mcp.DEFAULT_EXECUTION_TIMEOUT))
                .maxOutput(po.getMaxOutput() == null ? Mcp.DEFAULT_MAX_OUTPUT : po.getMaxOutput())
                .status(po.getStatus())
                .createAt(po.getCreateTime())
                .updateAt(po.getUpdateTime())
                .build();
    }



    /**
     * 枚举 → 库中形态（{@code streamable-http}）。
     * <p>列默认值与既有数据都是形态值（见 {@code init.sql}），写枚举名会让同一列出现两种写法。</p>
     */
    private String toTransportValue(Mcp.Transport transport) {
        return transport.name().toLowerCase(Locale.ROOT).replace('_', '-');
    }

    @Override
    protected McpPO toPO(Mcp model) {
        return McpPO.builder()
                .id(model.getId())
                .name(model.getName())
                .transport(toTransportValue(model.getTransport()))
                .url(model.getUrl())
                .headers(writeStringMap(model.getHeaders()))
                .command(writeCommand(model.getCommand()))
                .env(writeStringMap(model.getEnv()))
                .description(model.getDescription())
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
            Map<String, String> map = objectMapper.readValue(raw, new TypeReference<>() {
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
            List<String> command = objectMapper.readValue(raw, new TypeReference<>() {
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
