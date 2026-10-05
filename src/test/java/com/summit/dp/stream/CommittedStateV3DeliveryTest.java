package com.summit.dp.stream;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.shared.event.CommittedStateChange;
import com.summit.dp.shared.event.CommittedStateObserver;
import com.summit.dp.shared.event.CommittedStatePublisher;
import com.summit.dp.stream.application.protocol.StreamV3EventType;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import com.summit.dp.stream.infrastructure.listener.CommittedStateV3Observer;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * v3 实体提交事件的<b>真实入口投递</b>回归。
 *
 * <p><b>为什么要走真实业务入口而不是手工构造载荷</b>：手工构造 {@link CommittedStateChange} 只能证明
 * 「观察者会转换给定对象」，证不了「写库那一刻丢出去的事实确实带着正确的身份与版本」。本类一律通过
 * 真实仓储（{@link SessionMessageRepositoryImpl} / {@link ChatTurnRepositoryImpl} /
 * {@link SessionRepositoryImpl}）在真实事务里写库，让 {@link CommittedStatePublisher} 的
 * {@code afterCommit} 回调自然触发 {@link CommittedStateV3Observer}，再对<b>序列化后的帧</b>断言。</p>
 *
 * <p><b>覆盖的 5 条语义</b>：① 消息落库 → {@code MESSAGE_COMMITTED} 带原 {@code streamKey}；
 * ② 轮次结束 → {@code TURN_UPDATED} 带终值 {@code version} 与用量；③ 会话改名 → {@code SESSION_UPDATED}
 * 带递增 {@code version}；④ 重发历史失效 → {@code HISTORY_INVALIDATED} 带新 {@code historyRevision}；
 * ⑤ 事务回滚 → 一帧都不发。</p>
 *
 * <p>序列化用生产同款 {@link JsonConfig} 的 ObjectMapper：它把 {@code Long} 输出为字符串，
 * 因此 {@code data.sessionId} / {@code data.id} 等字段在帧里是字符串 —— 与前端契约一致，
 * 断言必须落在这一层才拦得住「类型分叉」。</p>
 */
class CommittedStateV3DeliveryTest {

    private static final long ROOT_SESSION_ID = 100L;
    private static final long MESSAGE_ID = 9001L;
    private static final long TURN_ID = 7001L;
    private static final String STREAM_KEY = "8001";

    private final ObjectMapper json = new JsonConfig().objectMapper();
    private final List<BlockingQueue<String>> delivered = new ArrayList<>();

    private EmbeddedDatabase database;
    private EventStreamPublisher publisher;
    private TransactionTemplate tx;

    private SessionRepositoryImpl sessions;
    private SessionMessageRepositoryImpl messages;
    private ChatTurnRepositoryImpl turns;

    @BeforeEach
    void setUp() throws Exception {
        database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("init.sql").build();
        tx = new TransactionTemplate(new DataSourceTransactionManager(database));

        SqlSessionTemplate sql = session(database);
        publisher = capturingPublisher();
        sessions = new SessionRepositoryImpl(sql.getMapper(SessionMapper.class));
        messages = new SessionMessageRepositoryImpl(sql.getMapper(SessionMessageMapper.class));
        turns = new ChatTurnRepositoryImpl(sql.getMapper(ChatTurnMapper.class));
        // 真实链路：仓储 → CommittedStatePublisher → CommittedStateV3Observer → EventStreamPublisher。
        CommittedStatePublisher changes = new CommittedStatePublisher(orderedObserverProvider(
                new CommittedStateV3Observer(publisher, new ChatTurnConverter(), json)));
        ReflectionTestUtils.setField(sessions, "statePublisher", changes);
        ReflectionTestUtils.setField(messages, "statePublisher", changes);
        ReflectionTestUtils.setField(turns, "statePublisher", changes);
    }

    @AfterEach
    void tearDown() {
        if (publisher != null) {
            publisher.close();
        }
        if (database != null) {
            database.shutdown();
        }
    }

    /** ① 消息落库：{@code MESSAGE_COMMITTED} 必须复用落库行自身的 streamKey，前端才能合并进已有气泡。 */
    @Test
    void persistedMessageEmitsCommittedFrameCarryingItsOwnStreamKey() throws Exception {
        subscribe();

        tx.executeWithoutResult(status -> {
            sessions.save(Session.builder().id(ROOT_SESSION_ID).name("会话").rootSessionId(0L).build());
            saveMessage(SessionMessage.builder()
                    .id(MESSAGE_ID).streamKey(STREAM_KEY).sessionId(ROOT_SESSION_ID).turnId(TURN_ID)
                    .type(SessionMessageType.USER).text("你好").build());
        });

        JsonNode frame = firstFrameOfType(StreamV3EventType.MESSAGE_COMMITTED);
        assertEquals(String.valueOf(ROOT_SESSION_ID), frame.get("rootSessionId").asText());
        assertEquals(String.valueOf(ROOT_SESSION_ID), frame.get("sessionId").asText());
        assertEquals(String.valueOf(TURN_ID), frame.get("turnId").asText());
        assertFalse(frame.get("eventId").asText().isBlank());
        JsonNode data = frame.get("data");
        assertEquals(STREAM_KEY, data.get("streamKey").asText(), "身份必须取自落库行，才能与实时增量合并");
        assertEquals(String.valueOf(MESSAGE_ID), data.get("messageId").asText());
        assertEquals(String.valueOf(ROOT_SESSION_ID), data.get("sessionId").asText());
        assertEquals(String.valueOf(TURN_ID), data.get("turnId").asText());
        assertEquals("USER", data.get("type").asText());
    }

    /** ② 轮次结束：{@code TURN_UPDATED} 载荷是 ChatTurnVO，带终值 version 与已采集用量。 */
    @Test
    void completedTurnEmitsTurnUpdatedWithFinalVersionAndUsage() throws Exception {
        subscribe();
        tx.executeWithoutResult(status -> {
            sessions.save(Session.builder().id(ROOT_SESSION_ID).name("会话").rootSessionId(0L).build());
            saveTurn(ChatTurn.accept(TURN_ID, ROOT_SESSION_ID, null, "deepseek", "deepseek"));
        });
        // 受理保存也是一次提交（version=1），先丢弃，只看终态那一帧。
        drainFrames();

        tx.executeWithoutResult(status -> {
            ChatTurn turn = turns.findById(TURN_ID).orElseThrow();
            turn.markRunning(java.time.Instant.now());
            turns.updateById(turn, ROOT_SESSION_ID);
            turn.markCompleted(11L, 22L, 33L, java.time.Instant.now());
            turns.updateById(turn, ROOT_SESSION_ID);
        });

        JsonNode frame = lastFrameOfType(StreamV3EventType.TURN_UPDATED);
        JsonNode data = frame.get("data");
        assertEquals(String.valueOf(TURN_ID), data.get("turnId").asText());
        assertEquals("COMPLETED", data.get("status").asText());
        assertEquals(33L, data.get("totalTokens").asLong());
        // 两轮 update + 一次 save = version 3；终值必须是落库后的值，不是提交前的旧值。
        assertEquals(3L, data.get("version").asLong(), "载荷版本应为落库终值，否则前端会用旧版本覆盖新状态");
    }

    /** ③ 会话改名：{@code SESSION_UPDATED} 带递增后的 version，前端按 version 合并。 */
    @Test
    void renamedSessionEmitsSessionUpdatedWithIncrementedVersion() throws Exception {
        subscribe();
        tx.executeWithoutResult(status ->
                sessions.save(Session.builder().id(ROOT_SESSION_ID).name("旧名").rootSessionId(0L).build()));
        drainFrames();

        tx.executeWithoutResult(status -> {
            Session session = sessions.findById(ROOT_SESSION_ID).orElseThrow();
            session.rename("新名字");
            sessions.updateById(session);
        });

        JsonNode frame = lastFrameOfType(StreamV3EventType.SESSION_UPDATED);
        JsonNode data = frame.get("data");
        assertEquals(String.valueOf(ROOT_SESSION_ID), data.get("id").asText());
        assertEquals("新名字", data.get("name").asText());
        assertEquals(2L, data.get("version").asLong(), "改名后 version 必须递增，前端才能覆盖旧快照");
    }

    /**
     * ④ 重发历史失效：{@code HISTORY_INVALIDATED} 带新代际，且必须路由到根会话连接。
     *
     * <p>直接驱动生产者在 {@code ConversationRollbackService} 里构造的同型通知（HISTORY 种类），
     * 但不重复其删除编排 —— 那条链路的删除范围已由 v2 的 {@code StreamPersistenceTest} 覆盖，
     * 本类只锁「通知 → v3 帧」这一段。</p>
     */
    @Test
    void historyInvalidatedEmitsNewRevisionRoutedToRootSession() throws Exception {
        subscribe();
        tx.executeWithoutResult(status -> {
            sessions.save(Session.builder().id(ROOT_SESSION_ID).name("会话").rootSessionId(0L).build());
            new CommittedStatePublisher(orderedObserverProvider(
                    new CommittedStateV3Observer(publisher, new ChatTurnConverter(), json)))
                    .publish(new CommittedStateChange(CommittedStateChange.Kind.HISTORY,
                            ROOT_SESSION_ID, ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID), 5L,
                            java.util.Set.of(String.valueOf(TURN_ID)), java.util.Set.of(), 5L));
        });

        JsonNode frame = firstFrameOfType(StreamV3EventType.HISTORY_INVALIDATED);
        assertEquals(String.valueOf(ROOT_SESSION_ID), frame.get("rootSessionId").asText());
        assertEquals("5", frame.get("historyRevision").asText());
        assertEquals("5", frame.get("data").get("historyRevision").asText());
        assertEquals(String.valueOf(ROOT_SESSION_ID), frame.get("data").get("rootSessionId").asText());
    }

    /** ⑤ 事务回滚：写库没提交，观察者走不到，一帧都不发。 */
    @Test
    void rolledBackTransactionEmitsNoFrame() {
        subscribe();
        tx.executeWithoutResult(status -> {
            sessions.save(Session.builder().id(ROOT_SESSION_ID).name("会话").rootSessionId(0L).build());
            saveMessage(SessionMessage.builder()
                    .id(MESSAGE_ID).streamKey(STREAM_KEY).sessionId(ROOT_SESSION_ID)
                    .type(SessionMessageType.USER).text("会被回滚").build());
            status.setRollbackOnly();
        });
        assertTrue(deliveredFrames().isEmpty(), "回滚不得下发任何 v3 帧");
    }

    /**
     * SYSTEM 行是框架内部上下文，不进入用户可见历史，不应产生 MESSAGE_COMMITTED。
     *
     * <p>同事务再写一条 USER 行作为<b>阳性对照</b>：证明「没有 SYSTEM 帧」是刻意跳过，
     * 而不是发布链路整体失效 —— 否则这个断言换个死链路也能通过。</p>
     */
    @Test
    void systemMessageIsSkippedWhileUserMessageStillPublishes() {
        subscribe();
        tx.executeWithoutResult(status -> {
            saveMessage(SessionMessage.builder()
                    .id(MESSAGE_ID).streamKey("sys-key").sessionId(ROOT_SESSION_ID)
                    .type(SessionMessageType.SYSTEM).text("内部").build());
            saveMessage(SessionMessage.builder()
                    .id(MESSAGE_ID + 1).streamKey("user-key").sessionId(ROOT_SESSION_ID)
                    .type(SessionMessageType.USER).text("可见").build());
        });
        List<JsonNode> committed = deliveredFrames().stream()
                .filter(frame -> StreamV3EventType.MESSAGE_COMMITTED.wireValue().equals(frame.get("type").asText()))
                .toList();
        assertEquals(1, committed.size(), "只应下发 USER 行一条");
        assertEquals("user-key", committed.getFirst().get("data").get("streamKey").asText());
    }

    /** AI 行落库前 text 存的是序列化 JSON，帧里必须还原为纯正文，否则前端会渲染出转义引号。 */
    @Test
    void aiMessageTextIsUnwrappedFromStoredJson() throws Exception {
        subscribe();
        String stored = json.writeValueAsString(AiMessageEntity.builder().text("真正文").build());
        tx.executeWithoutResult(status -> saveMessage(SessionMessage.builder()
                .id(MESSAGE_ID).streamKey(STREAM_KEY).sessionId(ROOT_SESSION_ID)
                .type(SessionMessageType.AI).text(stored).build()));

        JsonNode data = firstFrameOfType(StreamV3EventType.MESSAGE_COMMITTED).get("data");
        assertEquals("真正文", data.get("text").asText());
        assertEquals("AI", data.get("type").asText());
    }

    /**
     * ⑥ 子会话提交：消息与轮次都必须投到**根连接**，而实体归属仍用子会话自身。
     *
     * <p><b>只订阅根会话连接</b>（前端真实形态：一条根会话 v3 连接承载整棵树）。
     * {@code EventStreamPublisher.publish} 对没有订阅者的根会话桶是<b>静默丢弃</b>的，
     * 因此「按实体自身 sessionId 投递」这个缺陷在这里会表现为<b>一帧都收不到</b> ——
     * 子代理的正文与用量在根会话里凭空缺失，而不会报任何错。</p>
     */
    @Test
    void subSessionMessageAndTurnAreDeliveredOnRootConnection() {
        long subSessionId = 200L;
        subscribe();   // 只订阅 ROOT_SESSION_ID

        tx.executeWithoutResult(status -> {
            sessions.save(Session.builder().id(ROOT_SESSION_ID).name("根").rootSessionId(0L).build());
            sessions.save(Session.builder().id(subSessionId).name("子").rootSessionId(ROOT_SESSION_ID).build());
            saveMessage(SessionMessage.builder()
                    .id(MESSAGE_ID).streamKey(STREAM_KEY).sessionId(subSessionId).turnId(TURN_ID)
                    .type(SessionMessageType.USER).text("子任务").build());
            saveTurn(ChatTurn.accept(TURN_ID, subSessionId, null, "deepseek", "deepseek"));
        });

        // 一次性排空：deliveredFrames() 会 poll 掉队列，分两次取会把后一次取空。
        List<JsonNode> frames = deliveredFrames();
        List<String> seen = frames.stream().map(item -> item.get("type").asText()).toList();

        JsonNode messageFrame = frames.stream()
                .filter(item -> StreamV3EventType.MESSAGE_COMMITTED.wireValue().equals(item.get("type").asText()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("未收到 MESSAGE_COMMITTED，已收到: " + seen));
        assertEquals(String.valueOf(ROOT_SESSION_ID), messageFrame.get("rootSessionId").asText(),
                "子会话消息必须投到根连接，否则前端收不到");
        assertEquals(String.valueOf(subSessionId), messageFrame.get("sessionId").asText(),
                "实体归属仍必须是子会话自身");
        assertEquals(String.valueOf(subSessionId), messageFrame.get("data").get("sessionId").asText());

        JsonNode turnFrame = frames.stream()
                .filter(item -> StreamV3EventType.TURN_UPDATED.wireValue().equals(item.get("type").asText()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("未收到 TURN_UPDATED，已收到: " + seen));
        // 投递用根会话、归属用自身会话：信封上的两个字段各司其职。
        // （ChatTurnVO 本身不带 sessionId，实体归属只在信封的 sessionId 上表达。）
        assertEquals(String.valueOf(ROOT_SESSION_ID), turnFrame.get("rootSessionId").asText(),
                "子会话轮次同样必须投到根连接");
        assertEquals(String.valueOf(subSessionId), turnFrame.get("sessionId").asText(),
                "实体归属仍必须是子会话自身");
    }

    /**
     * 缺根身份的提交：**跳过并告警**，不回落自身会话。
     *
     * <p>回落正是「子会话提交静默投错桶」那条故障本身 —— 帧会被投进无人订阅的桶里丢掉，
     * 且不报任何错。宁可少一帧（有告警可查），也不要投错。</p>
     */
    @Test
    void messageWithoutRootIdentityIsSkippedInsteadOfFallingBackToOwnSession() {
        subscribe();
        tx.executeWithoutResult(status -> {
            sessions.save(Session.builder().id(ROOT_SESSION_ID).name("会话").rootSessionId(0L).build());
            // 不带根身份提交（旧入口 / 漏传根身份的调用方）
            messages.save(SessionMessage.builder()
                    .id(MESSAGE_ID).streamKey(STREAM_KEY).sessionId(ROOT_SESSION_ID).turnId(TURN_ID)
                    .type(SessionMessageType.USER).text("你好").build());
        });

        List<String> seen = deliveredFrames().stream().map(item -> item.get("type").asText()).toList();
        assertFalse(seen.contains(StreamV3EventType.MESSAGE_COMMITTED.wireValue()),
                "缺根身份不得投递、也不得回落自身会话，已收到: " + seen);
    }

    /**
     * ⑦ 子会话实体更新的信封契约：**信封 `historyRevision` 是实体自身字段，不是根代际**。
     *
     * <p><b>为什么这条必须锁</b>：前端入口守卫按「帧代际 &lt; 根当前代际」拒绝旧帧。若把 SESSION_UPDATED
     * 信封上的 `historyRevision` 当成根代际，就会误杀这条完全合法的更新 ——
     * {@code Session.historyRevision} 默认 {@code 1L}，而
     * {@code SubSessionResolver.createSubSession} <b>不继承</b>根会话代际。</p>
     *
     * <p>真实故障形态：根重发后 revision=2，新建子会话 revision 仍是 1，其 SESSION_UPDATED 被前端
     * 判为「旧代际」丢弃 → 子会话不进 `sessions` 槽 → 子面板、卡片冒泡、根子范围判定全部失灵。
     * 本用例断言两件事：① 信封带的是<b>实体自身</b> revision（因此前端不得拿它比根代际）；
     * ② 帧仍路由到<b>根连接</b>（否则前端根本收不到，问题会掩盖成「没事件」）。</p>
     */
    @Test
    void subSessionUpdatedCarriesItsOwnRevisionButRoutesToRoot() {
        long subSessionId = 200L;
        subscribe();   // 只订阅 ROOT_SESSION_ID

        tx.executeWithoutResult(status -> {
            // 根已推进到代际 2（模拟一次重发后的状态）。
            Session root = Session.builder().id(ROOT_SESSION_ID).name("根").rootSessionId(0L).build();
            root.advanceHistoryRevision();
            sessions.save(root);
            // 子会话走真实创建路径的字段形状：不继承根代际，historyRevision 保持默认 1。
            sessions.save(Session.builder().id(subSessionId).name("子").rootSessionId(ROOT_SESSION_ID).build());
        });
        drainFrames();

        tx.executeWithoutResult(status -> {
            Session sub = sessions.findById(subSessionId).orElseThrow();
            sub.rename("子改名");
            sessions.updateById(sub);
        });

        JsonNode frame = lastFrameOfType(StreamV3EventType.SESSION_UPDATED);
        assertEquals(String.valueOf(ROOT_SESSION_ID), frame.get("rootSessionId").asText(),
                "子会话实体更新必须投到根连接，否则前端收不到（会被静默丢弃）");
        assertEquals(String.valueOf(subSessionId), frame.get("sessionId").asText(),
                "实体归属仍是子会话自身");
        assertEquals("1", frame.get("historyRevision").asText(),
                "信封 revision 是实体自身字段（子会话不继承根代际）—— 前端不得拿它比根代际");
        assertEquals(2L, rootRevision(),
                "阴性对照：根代际此时确实是 2，所以 1 与 2 的落差是真实存在的，不是构造巧合");
        assertEquals("子改名", frame.get("data").get("name").asText(),
                "合法更新本身必须完整下发，前端的正确做法是靠实体 version 合并、不做代际拒绝");
    }

    /* --------------------------- 测试基建 --------------------------- */

    /**
     * 提交一条消息：**显式带根身份**。
     *
     * <p>根身份是 v3 投递目标，缺它观察者会跳过帧 —— 这正是本类要锁的语义，所以这里不省。</p>
     */
    private void saveMessage(SessionMessage message) {
        messages.save(message, ROOT_SESSION_ID);
    }

    /** 提交一个轮次：显式带根身份，理由同 {@link #saveMessage}。 */
    private void saveTurn(ChatTurn turn) {
        turns.save(turn, ROOT_SESSION_ID);
    }

    /** 读取根会话当前代际（用于阴性对照：证明「实体 revision 与根代际有落差」不是构造巧合）。 */
    private long rootRevision() {
        return sessions.findById(ROOT_SESSION_ID).orElseThrow().getHistoryRevision();
    }

    private SqlSessionTemplate session(EmbeddedDatabase database) throws Exception {
        MybatisConfiguration config = new MybatisConfiguration();
        config.setMapUnderscoreToCamelCase(true);
        config.addMapper(SessionMapper.class);
        config.addMapper(SessionMessageMapper.class);
        config.addMapper(ChatTurnMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(config);
        return new SqlSessionTemplate(factory.getObject());
    }

    @SuppressWarnings("unchecked")
    private ObjectProvider<CommittedStateObserver> orderedObserverProvider(CommittedStateObserver observer) {
        ObjectProvider<CommittedStateObserver> provider = mock(ObjectProvider.class);
        when(provider.orderedStream()).thenAnswer(call -> Stream.of(observer));
        return provider;
    }

    /** 用生产同款序列化捕获 v3 帧（复用 {@link EventStreamPublisherTest} 的 emitter 打桩手法）。 */
    private EventStreamPublisher capturingPublisher() {
        return new EventStreamPublisher(json) {
            @Override
            protected SseEmitter newEmitter() {
                SseEmitter emitter = mock(SseEmitter.class);
                BlockingQueue<String> frames = new LinkedBlockingQueue<>();
                delivered.add(frames);
                try {
                    doAnswer(call -> {
                        SseEmitter.SseEventBuilder builder = call.getArgument(0);
                        for (SseEmitter.DataWithMediaType part : builder.build()) {
                            if (part.getData() instanceof String text && text.startsWith("{")) {
                                frames.add(text);
                            }
                        }
                        return null;
                    }).when(emitter).send(any(SseEmitter.SseEventBuilder.class));
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
                return emitter;
            }
        };
    }

    private void subscribe() {
        publisher.subscribe(ROOT_SESSION_ID);
        // STREAM_READY 由订阅的发送线程异步入队；必须等它真的到达再清空，
        // 否则「清空」会赶在 READY 入队之前执行，留下一条与控制流无关的残帧。
        awaitFrameOfType(StreamV3EventType.STREAM_READY);
        drainFrames();
    }

    /** 阻塞等待某一类帧到达（最多 2 秒）；未到达即失败。 */
    private void awaitFrameOfType(StreamV3EventType type) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < deadline) {
            for (BlockingQueue<String> bucket : delivered) {
                for (String raw : bucket) {
                    try {
                        if (type.wireValue().equals(json.readTree(raw).get("type").asText())) {
                            return;
                        }
                    } catch (Exception error) {
                        throw new IllegalStateException(error);
                    }
                }
            }
            try {
                Thread.sleep(10);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(error);
            }
        }
        throw new AssertionError("未在超时前收到 " + type.wireValue() + " 帧");
    }

    /** 排空当前已下发的帧（用于「只看本次写入」的场景）。 */
    private void drainFrames() {
        for (BlockingQueue<String> bucket : delivered) {
            bucket.clear();
        }
    }

    private List<JsonNode> deliveredFrames() {
        List<JsonNode> frames = new ArrayList<>();
        for (BlockingQueue<String> bucket : delivered) {
            String raw;
            try {
                while ((raw = bucket.poll(50, TimeUnit.MILLISECONDS)) != null) {
                    frames.add(json.readTree(raw));
                }
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }
        return frames;
    }

    private JsonNode firstFrameOfType(StreamV3EventType type) {
        return frameOfType(type, true);
    }

    private JsonNode lastFrameOfType(StreamV3EventType type) {
        return frameOfType(type, false);
    }

    private JsonNode frameOfType(StreamV3EventType type, boolean first) {
        List<JsonNode> matches = deliveredFrames().stream()
                .filter(frame -> type.wireValue().equals(frame.get("type").asText()))
                .toList();
        assertFalse(matches.isEmpty(), "未收到 " + type.wireValue() + " 帧");
        return first ? matches.getFirst() : matches.getLast();
    }

    /** 防止「消息帧误带 eventId」这类无意义断言的静默通过 —— 保留字段存在性检查。 */
    @Test
    void frameCarriesSchemaVersionAndEventId() {
        subscribe();
        tx.executeWithoutResult(status -> saveMessage(SessionMessage.builder()
                .id(MESSAGE_ID).streamKey(STREAM_KEY).sessionId(ROOT_SESSION_ID)
                .type(SessionMessageType.USER).text("x").build()));
        JsonNode frame = firstFrameOfType(StreamV3EventType.MESSAGE_COMMITTED);
        assertEquals(StreamV3EventType.SCHEMA_VERSION, frame.get("schemaVersion").asInt());
        assertFalse(frame.get("eventId").asText().isBlank());
        assertNull(frame.get("seq"));
    }
}
