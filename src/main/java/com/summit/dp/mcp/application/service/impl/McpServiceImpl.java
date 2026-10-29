package com.summit.dp.mcp.application.service.impl;

import cn.hutool.core.util.IdUtil;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.core.conf.McpConfig;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.mcp.application.command.McpCommand;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.application.service.McpConnectionRegistry;
import com.summit.dp.mcp.application.vo.McpVO;
import com.summit.dp.mcp.application.vo.McpConnectionVO;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.*;

/**
 * Mcp 应用层服务实现。
 *
 * <p><b>凭据处理：</b>请求头与环境变量里的值常是令牌。查询出口一律脱敏（见 {@link #toVO}），
 * 更新入口识别到脱敏值则保留库中原值（见 {@link #mergeMaskedValues}）——这样前端把表单原样提交
 * 也不会把令牌覆盖成掩码串。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class McpServiceImpl implements McpService {

    private final McpRepository repository;
    private final McpValidator validator;
    private final McpConfigAssembler assembler;
    private final McpConnectionRegistry connections;

    @Override
    public Result<McpVO> findById(Long id) {
        if (id == null)
            throw new ClientException("id is null");
        Mcp model = repository.findById(id)
                .orElseThrow(() -> new ClientException("id 对应数据不存在: " + id));
        return Result.success(toVO(model));
    }

    @Override
    public Result<PageResult<McpVO>> findPage(Integer page, Integer pageSize) {
        int current = page == null ? 1 : Math.max(page, 1);
        int size = pageSize == null ? 10 : Math.max(pageSize, 1);
        IPage<Mcp> pageResult = repository.queryByPage(current, size);
        PageResult<McpVO> result = new PageResult<>(pageResult.getCurrent(), pageResult.getSize(),
                pageResult.getTotal(), pageResult.getRecords().stream().map(this::toVO).toList());
        return Result.success(result);
    }

    @Override
    public Result<McpConnectionVO> connect(McpCommand command) {
        String error = validator.validateForConnection(command);
        throwIf(error != null, error);
        Mcp model = toModel(command, Instant.now());
        if (command.getId() != null) {
            Mcp saved = repository.findById(command.getId()).orElseThrow(()->new ClientException("未找到MCP服务数据: " + command.getId()));
            // 查询结果已脱敏，测试时仅在独立配置中还原凭据，不能修改已保存配置。
            model.changeHeaders(command.getHeaders() == null
                    ? saved.getHeaders() : mergeMaskedValues(command.getHeaders(), saved.getHeaders()));
            model.changeEnv(command.getEnv() == null
                    ? saved.getEnv() : mergeMaskedValues(command.getEnv(), saved.getEnv()));
        }
        model.requireCoherent();
        return Result.success(connections.connect(assembler.toServer(model)));
    }

    @Override
    public Result<Void> add(McpCommand command) {
        String error = validator.validateForCreate(command);
        throwIf(error != null, error);

        Mcp model;
        try {
            model = toModel(command, Instant.now());
            model.requireCoherent();
            repository.save(model);
        } catch (IllegalArgumentException e) {
            // 领域方法的护栏（长度/正数/传输-参数匹配等）；校验器已覆盖常规路径，这里兜住直接构造的非法值
            log.warn("新增 MCP 被领域规则拒绝: error={}", e.getMessage());
            throw new ClientException(e.getMessage());
        }
        // 必须先保存再连接；远端故障不能让用户丢失配置。
        connections.register(model.getId());
        return Result.success();
    }

    @Override
    public Result<Void> update(McpCommand command) {
        String error = validator.validateForUpdate(command);
        throwIf(error != null, error);

        Mcp model = repository.findById(command.getId())
                .orElseThrow(ClientException::new);

        try {
            applyChanges(command, model);
            model.requireCoherent();
        } catch (IllegalArgumentException e) {
            log.warn("更新 MCP 被领域规则拒绝: error={}", e.getMessage());
            throw new ClientException(e.getMessage());
        }

        repository.updateById(model);
        connections.register(model.getId());
        return Result.success();
    }

    @Override
    public Result<Void> delById(Long id) {
        throwIf(id == null, "MCP 配置标识不能为空");
        repository.findById(id).ifPresent(repository::delete);
        connections.remove(id);
        return Result.success();
    }

    @Override
    public Result<List<McpVO>> queryIn(Collection<Long> ids) {
        if (ids == null || ids.isEmpty())
            return Result.success(List.of());
        return Result.success(repository.findList(ids).stream().map(this::toVO).toList());
    }

    /**
     * 组装框架侧配置：仅启用项参与，按库中顺序稳定输出。
     *
     * <p>真实凭据只供运行配置版本库和连接器使用，不能直接放入执行快照。</p>
     */
    @Override
    public McpConfig currentConfig() {
        List<Mcp> enabled = repository.findEnabled();
        if (enabled.isEmpty()) return null;

        McpConfig config = new McpConfig();
        config.setMcp(enabled.stream().map(assembler::toServer).toList());
        return config;
    }

    /**
     * 入参的传输方式是「线上形态」字符串（{@code streamable-http} / {@code sse} / {@code stdio}），
     * 枚举常量名是下划线大写形态，直接 {@code valueOf} 取不到——先归一化再取。
     * 非法值抛 {@link IllegalArgumentException}，与其他领域护栏同样是「请求非法」而非系统故障。
     */
    private Mcp.Transport parseTransport(String transport) {
        return Mcp.Transport.valueOf(transport.trim().toUpperCase(Locale.ROOT).replace('-', '_'));
    }

    /**
     * 枚举 → 线上形态（{@code streamable-http}）。
     * <p>接口出参必须是形态值：前端按 {@code transport === 'stdio'} 判断 stdio 提示与表单分支，
     * 枚举名（{@code STDIO}）会让这些判断全部落空。</p>
     */
    private String wireOf(Mcp.Transport transport) {
        return transport.name().toLowerCase(Locale.ROOT).replace('_', '-');
    }

    /** 逐字段条件变更：只动显式传入的字段，缺省字段保持原值 */
    private void applyChanges(McpCommand command, Mcp model) {
        if (command.getName() != null) model.changeName(command.getName().trim());
        if (command.getTransport() != null) model.changeTransport(parseTransport(command.getTransport()));
        if (command.getUrl() != null) model.changeUrl(command.getUrl().trim());
        if (command.getHeaders() != null)
            model.changeHeaders(mergeMaskedValues(command.getHeaders(), model.getHeaders()));
        if (command.getCommand() != null) model.changeCommand(command.getCommand());
        if (command.getEnv() != null)
            model.changeEnv(mergeMaskedValues(command.getEnv(), model.getEnv()));
        if (command.getDescription() != null) model.changeDescription(command.getDescription().trim());
        if (command.getInitializationTimeout() != null)
            model.changeInitializationTimeout(Duration.ofMillis(command.getInitializationTimeout()));
        if (command.getExecutionTimeout() != null)
            model.changeExecutionTimeout(Duration.ofMillis(command.getExecutionTimeout()));
        if (command.getMaxOutput() != null) model.changeMaxOutput(command.getMaxOutput());
        if (command.getStatus() != null) model.changeEnabled(command.getStatus() == Mcp.STATUS_ENABLED);

        // 4 个客户端容错字段刻意「无条件覆盖」，不做 null 判断（与上面老字段的条件变更不同）：
        // 1. 它们是本次新增，库中历史行全为 NULL，不存在「老数据被误清」的风险；
        // 2. update 的唯一调用方是设置页表单，且表单全量提交（四个控件状态始终随请求带上）；
        // 3. 若沿用 null=保持原值，用户在 UI 上就永远清不掉已填的协议版本（单向开关），
        //    而这 4 个字段的 null 恰恰有语义：走客户端库默认。
        model.changeProtocolVersion(toProtocolVersionOrNull(command.getProtocolVersion()));
        model.changeAutoHealthCheck(command.getAutoHealthCheck());
        model.changeHealthCheckInterval(toDurationOrNull(command.getHealthCheckInterval()));
        model.changeReconnectInterval(toDurationOrNull(command.getReconnectInterval()));
    }

    /**
     * 毫秒 → Duration，null 保持 null。
     * <p>客户端容错字段的 null 是「沿用客户端库默认」，不能回落到任何业务缺省值。</p>
     */
    private Duration toDurationOrNull(Long millis) {
        return millis == null ? null : Duration.ofMillis(millis);
    }

    /**
     * 归一协议版本：空白视同未设置（null），其余 trim 后原样返回。
     * <p>空字符串冒充 null 会让「清空输入框」下发出一个非法版本，这里收口成 null。</p>
     */
    private String toProtocolVersionOrNull(String protocolVersion) {
        if (protocolVersion == null) return null;
        String trimmed = protocolVersion.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /**
     * 合并凭据键值对（headers 与 env 通用）：值为脱敏掩码的条目保留库中原值。
     *
     * <p>否则前端「查出来—直接提交」的常规操作会把真实令牌写成掩码串，服务随即连不上，
     * 而错误现象（401）与真实原因（值被覆盖）相距很远，排查成本极高。</p>
     */
    private Map<String, String> mergeMaskedValues(Map<String, String> incoming, Map<String, String> existing) {
        if (incoming.isEmpty()) return Map.of();
        Map<String, String> current = existing == null ? Map.of() : existing;

        Map<String, String> merged = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : incoming.entrySet()) {
            String key = entry.getKey() == null ? null : entry.getKey().trim();
            if (key == null || key.isEmpty()) continue;
            String value = entry.getValue();
            if (McpVO.MASKED_VALUE.equals(value)) {
                String original = current.get(key);
                // 掩码值但库中并无该键：说明是前端凭空造出的，丢掉而不是写入掩码串
                if (original != null) merged.put(key, original);
                continue;
            }
            merged.put(key, value);
        }
        return merged;
    }

    private McpVO toVO(Mcp model) {
        return McpVO.builder()
                .id(model.getId())
                .name(model.getName())
                .transport(model.getTransport() == null ? null : wireOf(model.getTransport()))
                .url(model.getUrl())
                .headers(maskValues(model.getHeaders()))
                .command(model.getCommand())
                .env(maskValues(model.getEnv()))
                .description(model.getDescription())
                .initializationTimeout(model.getInitializationTimeout() == null
                        ? null : model.getInitializationTimeout().toMillis())
                .executionTimeout(model.getExecutionTimeout() == null
                        ? null : model.getExecutionTimeout().toMillis())
                .protocolVersion(model.getProtocolVersion())
                .autoHealthCheck(model.getAutoHealthCheck())
                .healthCheckInterval(model.getHealthCheckInterval() == null
                        ? null : model.getHealthCheckInterval().toMillis())
                .reconnectInterval(model.getReconnectInterval() == null
                        ? null : model.getReconnectInterval().toMillis())
                .maxOutput(model.getMaxOutput())
                .status(model.getStatus())
                .build();
    }

    /** 只保留键名，值统一替换为掩码；前端据此渲染「已配置」（headers 与 env 通用） */
    private Map<String, String> maskValues(Map<String, String> map) {
        if (map == null || map.isEmpty()) return Map.of();
        Map<String, String> masked = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : map.entrySet()) {
            masked.put(entry.getKey(), McpVO.MASKED_VALUE);
        }
        return masked;
    }

    private Mcp toModel(McpCommand command, Instant now) {
        return Mcp.builder()
                .id(command.getId() == null ? IdUtil.getSnowflakeNextId() : command.getId())
                .name(command.getName().trim())
                .transport(command.getTransport() == null ? Mcp.Transport.STREAMABLE_HTTP : parseTransport(command.getTransport()))
                .url(command.getUrl() == null ? null : command.getUrl().trim())
                .headers(command.getHeaders() == null ? Map.of() : command.getHeaders())
                .command(command.getCommand())
                .env(command.getEnv() == null ? Map.of() : command.getEnv())
                .description(command.getDescription() == null ? null : command.getDescription().trim())
                .initializationTimeout(command.getInitializationTimeout() == null
                        ? Mcp.DEFAULT_INITIALIZATION_TIMEOUT : Duration.ofMillis(command.getInitializationTimeout()))
                .executionTimeout(command.getExecutionTimeout() == null
                        ? Mcp.DEFAULT_EXECUTION_TIMEOUT : Duration.ofMillis(command.getExecutionTimeout()))
                .maxOutput(command.getMaxOutput() == null ? Mcp.DEFAULT_MAX_OUTPUT : command.getMaxOutput())
                // 客户端容错参数原样透传：这里严禁套用任何缺省值，null 就是「沿用客户端库默认」
                .protocolVersion(toProtocolVersionOrNull(command.getProtocolVersion()))
                .autoHealthCheck(command.getAutoHealthCheck())
                .healthCheckInterval(toDurationOrNull(command.getHealthCheckInterval()))
                .reconnectInterval(toDurationOrNull(command.getReconnectInterval()))
                .status(command.getStatus() == null ? Mcp.STATUS_ENABLED : command.getStatus())
                .createAt(now)
                .updateAt(now)
                .build();
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
