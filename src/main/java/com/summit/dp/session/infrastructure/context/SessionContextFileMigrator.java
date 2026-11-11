package com.summit.dp.session.infrastructure.context;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.Message;
import com.summit.dp.session.application.port.SessionContextStore;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 把库内历史正文搬成文件的一次性迁移。
 *
 * <p><b>为什么放在启动期</b>：改动之后正文的读路径只认正文标识，库里那批
 * {@code snapshot_file IS NULL} 的老行如果不搬，用户打开旧会话就会看不到历史。迁移必须在建库
 * 之后、任何业务 runner 之前跑完（{@code SchemaBootstrapConfig} 用 {@link Ordered#HIGHEST_PRECEDENCE}，
 * 这里紧随其后）。</p>
 *
 * <p><b>顺序与幂等</b>：先落盘、再条件更新（{@code snapshot_file IS NULL}），因此重入时第二次
 * 命中 0 行；此时刚写出的那份文件没有任何引用，当场删掉，不留孤儿。搬完顺手把库内旧正文置空 ——
 * 留着它只会继续占住 MVStore 的 LOB 块，而文件已经是权威。</p>
 *
 * <p><b>失败不阻断启动</b>：单行解析失败只记 error 并跳过，该行原样留在库里（数据没丢），
 * 下次启动继续重试。为了一行坏数据让整个应用起不来，代价远大于收益。</p>
 */
@Slf4j
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
@RequiredArgsConstructor
public class SessionContextFileMigrator implements ApplicationRunner {

    /** 单批条数：每行都要解析几十万到上百万字符，小批更适合摊平内存峰值。 */
    private static final int BATCH = 20;

    private final SessionContextMapper mapper;
    private final SessionContextStore store;
    private final ObjectMapper objectMapper;

    @Override
    public void run(ApplicationArguments args) {
        long afterSessionId = 0L;
        int migrated = 0;
        int failed = 0;
        while (true) {
            List<SessionContextPO> batch = mapper.selectLegacyContexts(afterSessionId, BATCH);
            if (batch.isEmpty()) {
                break;
            }
            for (SessionContextPO row : batch) {
                afterSessionId = row.getSessionId();
                if (migrateOne(row)) {
                    migrated++;
                } else {
                    failed++;
                }
            }
        }
        if (migrated > 0 || failed > 0) {
            log.info("会话上下文正文外置: migrated={}, failed={}", migrated, failed);
        }
    }

    /** @return 是否成功换成文件引用；失败时该行原样留在库里，等下次启动重试 */
    private boolean migrateOne(SessionContextPO row) {
        List<Message> messages;
        try {
            messages = objectMapper.readValue(row.getContent(), new TypeReference<>() {
            });
        } catch (Exception failure) {
            log.error("会话上下文迁移失败，正文仍留在库内待下次重试: sessionId={}, error={}",
                    row.getSessionId(), failure.toString());
            return false;
        }
        String bodyId = store.write(row.getSessionId(), messages);
        if (mapper.assignSnapshotFile(row.getSessionId(), bodyId) != 1) {
            // 别人先写好了引用（同一行的 replace 抢在前面）：本次这份文件没人会读到，删掉。
            store.delete(row.getSessionId(), bodyId);
            log.warn("会话上下文迁移未命中待迁移行: sessionId={}", row.getSessionId());
            return false;
        }
        return true;
    }
}
