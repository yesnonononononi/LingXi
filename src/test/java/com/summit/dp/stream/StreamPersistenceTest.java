package com.summit.dp.stream;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.shared.config.H2SchemaInitializer;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.session.infrastructure.persistence.mapper.*;
import com.summit.dp.session.infrastructure.persistence.po.*;
import com.summit.dp.session.infrastructure.persistence.repository.*;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.session.application.convert.TranscriptRecordAssembler;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.infrastructure.transcript.DatabaseConversationTranscriptSink;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.shared.event.*;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import com.summit.dp.stream.infrastructure.StreamResponseIdentityInterceptor;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.jdbc.datasource.embedded.*;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.beans.factory.ObjectProvider;
import java.util.*;
import java.util.stream.Stream;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class StreamPersistenceTest {
    private SqlSessionTemplate session(EmbeddedDatabase database) throws Exception {
        MybatisConfiguration config = new MybatisConfiguration(); config.setMapUnderscoreToCamelCase(true);
        config.addMapper(SessionMapper.class); config.addMapper(SessionMessageMapper.class);
        config.addMapper(ChatTurnMapper.class); config.addMapper(ExecutionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database); factory.setConfiguration(config);
        return new SqlSessionTemplate(factory.getObject());
    }
    @Test void allLegacyStreamColumnsUpgradeTwiceWithoutLosingWaitingExecutionAndMessages() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("stream-legacy-schema.sql").build();
        try {
            H2SchemaInitializer bootstrap = new H2SchemaInitializer();
            bootstrap.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            bootstrap.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            SqlSessionTemplate sql = session(database);
            assertEquals("升级前的会话", sql.getMapper(SessionMapper.class).selectById(1).getName());
            assertEquals(1L, sql.getMapper(SessionMapper.class).selectById(1).getVersion());
            assertEquals(1L, sql.getMapper(SessionMapper.class).selectById(1).getHistoryRevision());
            assertEquals(1L, sql.getMapper(ChatTurnMapper.class).selectById(7).getVersion());
            assertEquals(1L, sql.getMapper(ExecutionMapper.class).selectById(11).getVersion());
            assertEquals("保留检查点", sql.getMapper(ExecutionMapper.class).selectById(11).getSnapshot());
            SessionMessageMapper messages = sql.getMapper(SessionMessageMapper.class);
            assertEquals("保留历史", messages.selectById(90).getContent());
            assertNull(messages.selectById(90).getStreamKey());
            messages.insert(SessionMessagePO.builder().id(91L).sessionId(1L).type("AI").streamKey("response").content("a").build());
            assertThrows(RuntimeException.class, () -> messages.insert(SessionMessagePO.builder().id(92L).sessionId(1L)
                    .type("AI").streamKey("response").content("b").build()));
        } finally { database.shutdown(); }
    }
    @Test void staleSessionAndTurnWritesCannotEraseNewerCommittedState() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("init.sql").build();
        try {
            SqlSessionTemplate sql = session(database);
            SessionRepositoryImpl sessions = new SessionRepositoryImpl(sql.getMapper(SessionMapper.class));
            sessions.save(Session.builder().id(1L).name("原名").rootSessionId(0L).build());
            Session first = sessions.findById(1L).orElseThrow(ClientException::new);
            Session stale = sessions.findById(1L).orElseThrow(ClientException::new);
            first.advanceHistoryRevision(); sessions.updateById(first);
            assertThrows(ClientException.class, () -> sessions.updateById(stale));
            assertEquals(2L, sessions.findById(1L).orElseThrow(ClientException::new).getHistoryRevision());
            ChatTurnRepositoryImpl turns = new ChatTurnRepositoryImpl(sql.getMapper(ChatTurnMapper.class));
            turns.save(ChatTurn.builder().id(7L).sessionId(1L).status(ChatTurnStatus.ACCEPTED).build());
            ChatTurn turn = turns.findById(7L).orElseThrow(ClientException::new);
            ChatTurn older = turns.findById(7L).orElseThrow(ClientException::new);
            turns.updateById(turn);
            assertThrows(ClientException.class, () -> turns.updateById(older));
            assertEquals(2L, turns.findById(7L).orElseThrow(ClientException::new).getVersion());
        } finally { database.shutdown(); }
    }
    @SuppressWarnings("unchecked")
    @Test void transcriptRollbackRetryReusesKeyAndOnlyCommittedRowsNotify() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("init.sql").build();
        try {
            SqlSessionTemplate sql = session(database);
            SessionMessageMapper mapper = sql.getMapper(SessionMessageMapper.class);
            SessionMessageRepositoryImpl messages = new SessionMessageRepositoryImpl(mapper);
            ObjectProvider<CommittedStateObserver> observers = mock(ObjectProvider.class);
            List<CommittedStateChange> changes = new ArrayList<>();
            when(observers.orderedStream()).thenAnswer(call -> Stream.of((CommittedStateObserver) change -> {
                assertNotNull(mapper.selectById(Long.valueOf(change.id()))); changes.add(change);
            }));
            ReflectionTestUtils.setField(messages, "statePublisher", new CommittedStatePublisher(observers));
            ConversationTranscriptService transcript = new ConversationTranscriptService(messages, mock(ToolCallRepository.class),
                    new TranscriptRecordAssembler(new JsonConfig().objectMapper()));
            ExecutionIdentity identity = mock(ExecutionIdentity.class); when(identity.sessionId("11")).thenReturn(1L);
            DatabaseConversationTranscriptSink sink = new DatabaseConversationTranscriptSink(transcript, identity);
            AiMessageEntity ai = AiMessageEntity.builder().text("回答").build();
            // 响应身份改由事件元数据直取：同一轮重复落库必须复用同一个 streamKey，
            // 才能被 (session_id, stream_key) 幂等拦住，避免回滚重试写出第二条回答。
            String key = "70001";
            Map<String, Object> metadata = Map.of("streamKey", key);
            TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(database));
            tx.executeWithoutResult(status -> { sink.appendRound("11", ai, List.of(), metadata); status.setRollbackOnly(); });
            assertEquals(0L, mapper.selectCount(null)); assertTrue(changes.isEmpty());
            tx.executeWithoutResult(status -> sink.appendRound("11", ai, List.of(), metadata));
            assertEquals(1L, mapper.selectCount(null)); assertEquals(1, changes.size());
            assertEquals(key, messages.findBySessionId(1L).getFirst().getStreamKey());
            tx.executeWithoutResult(status -> sink.appendRound("11", ai, List.of(), metadata));
            assertEquals(1L, mapper.selectCount(null)); assertEquals(1, changes.size());
        } finally { database.shutdown(); }
    }

    @Test
    void interceptorKeyFlowsUnchangedIntoPersistedAiRow() throws Exception {
        // 用标准 init.sql 建库（含 stream_key 列）。旧 schema 脚本没有该列，
        // 用它建的库会让 streamKey 被 H2 静默丢弃，测出一条与产品代码无关的假失败。
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("init.sql").build();
        try {
            SqlSessionTemplate sql = session(database);
            SessionMessageMapper mapper = sql.getMapper(SessionMessageMapper.class);
            SessionMessageRepositoryImpl messages = new SessionMessageRepositoryImpl(mapper);
            ObjectProvider<CommittedStateObserver> observers = mock(ObjectProvider.class);
            when(observers.orderedStream()).thenAnswer(call -> Stream.empty());
            ReflectionTestUtils.setField(messages, "statePublisher", new CommittedStatePublisher(observers));
            ConversationTranscriptService transcript = new ConversationTranscriptService(messages, mock(ToolCallRepository.class),
                    new TranscriptRecordAssembler(new JsonConfig().objectMapper()));
            ExecutionIdentity identity = mock(ExecutionIdentity.class); when(identity.sessionId("11")).thenReturn(1L);
            DatabaseConversationTranscriptSink sink = new DatabaseConversationTranscriptSink(transcript, identity);

            // 端到端不变量：拦截器写回的 key 必须原样出现在落库行上。
            // 这是「实时身份与落库身份同源」的唯一证据 —— 中间任何一次复制丢了键，
            // 前端就会出现「实时一条回答、历史另一条回答」，而各自的单测都不会报错。
            AgentRuntimeParameters parameters = AgentRuntimeParameters.builder()
                    .eventMetaData(Map.of(ExecutionEventMetadata.ROOT_SESSION_ID, "1",
                            ExecutionEventMetadata.SESSION_ID, "1",
                            ExecutionEventMetadata.HISTORY_REVISION, "1"))
                    .build();
            Execution execution = Execution.builder().id("11")
                    .agentRequest(AgentRequest.builder().runtimeParameters(parameters).build()).build();
            new StreamResponseIdentityInterceptor(new EventStreamPublisher(new JsonConfig().objectMapper())).onBeforeModelInvoke(new LoopContext(
                    execution, new ExecutionControlSignal("11"), 0, execution.eventMetaData(), ignored -> { }));

            String written = ExecutionEventMetadata.streamKey(execution.eventMetaData());
            assertNotNull(written);
            sink.appendRound("11", AiMessageEntity.builder().text("回答").build(), List.of(), execution.eventMetaData());

            assertEquals(written, messages.findBySessionId(1L).getFirst().getStreamKey());
        } finally { database.shutdown(); }
    }
}
