package com.summit.dp.execution.application.service;

import cn.hutool.core.util.IdUtil;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.summit.core.conf.McpConfig;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.SensitiveDataSpec;
import com.summit.dp.execution.domain.model.RuntimeConfigRevision;
import com.summit.dp.execution.domain.repository.RuntimeConfigRevisionRepository;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.locks.LockSupport;

/** 凭据只保留在业务配置库，执行快照只引用不可变版本。 */
@Service
public class RuntimeConfigurationService {
    private static final String MODEL = "MODEL";
    private static final String MCP = "MCP";
    private static final long MCP_CONFIG_ID = 1L;
    /** 并发分配版本号的最大尝试次数（仅在没有外层事务时使用）。 */
    private static final int MAX_FREEZE_ATTEMPTS = 8;
    /** 并发分配版本号时的重试退避（毫秒）；只用于锁冲突/唯一键冲突，不做无限等待。 */
    private static final long RETRY_BACKOFF_MILLIS = 5L;
    private final RuntimeConfigRevisionRepository repository;
    private final ObjectMapper mapper;
    private final TransactionTemplate transactions;

    public RuntimeConfigurationService(RuntimeConfigRevisionRepository repository, ObjectMapper mapper,
                                       PlatformTransactionManager transactionManager) {
        this.repository = repository;
        this.mapper = mapper.copy().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
        this.transactions = new TransactionTemplate(transactionManager);
        // 配置版本先独立提交，再由受理事务引用，避免恢复时读取尚未提交的配置。
        this.transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    public SensitiveDataSpec freezeModel(Long modelId, ModelConfig config) {
        throwIf(modelId == null || modelId <= 0 || config == null, "冻结模型配置必须提供有效模型标识和连接参数");
        return freeze(MODEL, modelId, config);
    }

    public SensitiveDataSpec freezeMcp(McpConfig config) {
        return config == null ? null : freeze(MCP, MCP_CONFIG_ID, config);
    }

    public ModelConfig resolveModel(Number id, int version) {
        return resolve(MODEL, id, version, ModelConfig.class);
    }

    public McpConfig resolveMcp(Number id, int version) {
        return resolve(MCP, id, version, McpConfig.class);
    }

    private SensitiveDataSpec freeze(String kind, long configId, Object config) {
        String payload;
        try {
            payload = mapper.writeValueAsString(config);
        } catch (JsonProcessingException e) {
            throw new ClientException("运行配置无法保存，请检查配置格式");
        }
        String fingerprint;
        try {
            fingerprint = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("运行环境不支持配置摘要算法", e);
        }
        SensitiveDataSpec frozen = findFrozen(kind, configId, fingerprint, payload);
        if (frozen != null) {
            return frozen;
        }
        // 分配新版本必须独立提交。若外层事务已开启，只有「外层还没写过库」时才可能成功
        // （单写者下另一条写连接会与外层抢锁），因此这里只尝试一次：成功即保持原语义，
        // 失败则给出可诊断的错误，而不是在 busy_timeout 里排队等死。
        boolean nested = TransactionSynchronizationManager.isActualTransactionActive();
        int attempts = nested ? 1 : MAX_FREEZE_ATTEMPTS;
        for (int attempt = 0; attempt < attempts; attempt++) {
            try {
                return Objects.requireNonNull(transactions.execute(status -> {
                    RuntimeConfigRevision existing = repository.findMatching(kind, configId, fingerprint).orElse(null);
                    if (existing != null) {
                        throwIf(!payload.equals(existing.getPayload()), "运行配置摘要冲突，无法确定历史版本");
                        return SensitiveDataSpec.builder().id(configId).version(existing.getRevision()).build();
                    }
                    int previous = repository.latestRevision(kind, configId);
                    throwIf(previous == Integer.MAX_VALUE, "运行配置版本数量已达到上限");
                    int revision = previous + 1;
                    repository.save(RuntimeConfigRevision.builder().id(IdUtil.getSnowflakeNextId()).kind(kind)
                            .configId(configId).revision(revision).fingerprint(fingerprint).payload(payload)
                            .createdAt(Instant.now()).build());
                    return SensitiveDataSpec.builder().id(configId).version(revision).build();
                }));
            } catch (DuplicateKeyException | CannotAcquireLockException conflict) {
                // 唯一约束裁决并发分配；锁冲突说明别的连接正在提交（单写者读后升写会立刻失败）。
                // 两者都必须在新事务里重试，不能复用失败事务。
                if (nested) {
                    throw new ClientException("运行配置必须在事务开始前冻结：单写者数据库里"
                            + "已开启的事务（尤其是已写过库的事务）不能再另开写事务", conflict);
                }
                LockSupport.parkNanos(RETRY_BACKOFF_MILLIS * 1_000_000L * (attempt + 1));
            }
        }
        throw new ClientException("运行配置正在并发更新，请稍后重试");
    }

    /**
     * 快路径：当前连接上查一次是否已冻结过同一份配置。
     *
     * <p><b>为什么必须有</b>：调用方可能已经预冻结（外层写入之前），随后在外层事务里再要一次
     * 规格。此时<b>不能</b>再开新事务——单写者下那会与外层抢写锁。这里只做一次普通读取：
     * 有外层事务时它在同一条连接上读，没有时走自动提交读，两种情况都不会额外持锁。</p>
     *
     * @return 已冻结的规格；没有匹配版本时返回 {@code null}
     */
    private SensitiveDataSpec findFrozen(String kind, long configId, String fingerprint, String payload) {
        RuntimeConfigRevision existing = repository.findMatching(kind, configId, fingerprint).orElse(null);
        if (existing == null) {
            return null;
        }
        throwIf(!payload.equals(existing.getPayload()), "运行配置摘要冲突，无法确定历史版本");
        return SensitiveDataSpec.builder().id(configId).version(existing.getRevision()).build();
    }

    private <T> T resolve(String kind, Number id, int version, Class<T> type) {
        throwIf(id == null || version <= 0, "运行配置引用必须包含有效标识和版本");
        long configId;
        try {
            configId = new BigDecimal(id.toString()).longValueExact();
        } catch (ArithmeticException | NumberFormatException e) {
            throw new ClientException("运行配置标识必须是有效整数");
        }
        Optional<RuntimeConfigRevision> found = repository.findRevision(kind, configId, version);
        throwIf(found.isEmpty(), "运行配置历史版本不存在: type=" + kind + ", id=" + configId + ", version=" + version);
        RuntimeConfigRevision revision = found.orElseThrow(ClientException::new);
        try {
            return mapper.readValue(revision.getPayload(), type);
        } catch (JsonProcessingException e) {
            // 解析异常可能携带原始凭据，不能附到异常链。
            throw new ClientException("运行配置历史版本无法读取: type=" + kind + ", id=" + configId + ", version=" + version);
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
