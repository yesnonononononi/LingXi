package com.summit.dp.instruction;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.instruction.api.vo.InstructionVO;
import com.summit.dp.instruction.application.service.impl.InstructionServiceImpl;
import com.summit.dp.instruction.domain.model.Instruction;
import com.summit.dp.instruction.domain.repository.InstructionRepository;
import com.summit.dp.model.application.service.ModelChatGateway;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.service.UserConfigService;
import com.summit.dp.user_configs.application.vo.UserConfigVO;
import com.summit.dp.workflow.application.chat.PendingChatQueue;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.dao.DuplicateKeyException;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/** 指令预测：单入口语义、终态判定、正文提取口径与失败边界。 */
class InstructionPredictTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long SESSION_ID = 7L;
    private static final long TURN_ID = 11L;
    private static final long PREDICATE_MODEL_ID = 5L;

    private final InstructionRepository instructionRepository = mock(InstructionRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final PendingChatQueue pendingChats = mock(PendingChatQueue.class);
    private final UserConfigService userConfigService = mock(UserConfigService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final ModelChatGateway chatGateway = mock(ModelChatGateway.class);
    /** 假仓储里已落库的预测，按「会话:轮次」索引；saveCount 用于「只写一次」的计数断言。 */
    private final Map<String, Instruction> store = new ConcurrentHashMap<>();
    private final AtomicInteger saveCount = new AtomicInteger();
    private final InstructionServiceImpl service = new InstructionServiceImpl(instructionRepository, sessionRepository,
            messageRepository, chatTurnRepository, pendingChats, userConfigService, modelService, settingsProvider,
            chatGateway, JSON);

    @BeforeEach
    void setUp() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(rootSession()));
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID)).thenReturn(Optional.empty());
        when(userConfigService.current()).thenReturn(Result.success(
                UserConfigVO.builder().predicateModelId(PREDICATE_MODEL_ID).build()));
        when(pendingChats.hasPending(SESSION_ID)).thenReturn(false);
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(turn(ChatTurnStatus.COMPLETED)));
        when(settingsProvider.current()).thenReturn(Optional.empty());
        when(modelService.runtimeConfig(eq(PREDICATE_MODEL_ID), any())).thenReturn(ModelConfig.builder()
                .baseUrl("https://example.invalid/v1").apiKey("key").modelName("predict-model")
                .maxTokens(32768).returnThinking(true).sendThinking(true).build());
        when(chatGateway.chat(any(), any(), any())).thenReturn(response("帮我补一个单元测试"));
    }

    @Test
    @DisplayName("子会话：即使已有旧预测也直接拒绝，不返回也不生成")
    void subSessionIsRejected() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).rootSessionId(1L).build()));
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID)).thenReturn(Optional.of(
                Instruction.builder().sessionId(SESSION_ID).turnId(TURN_ID).nextInstruction("子会话残留预测")
                        .createAt(Instant.now()).build()));

        assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));
        verifyNoInteractions(chatGateway, messageRepository);
        verify(instructionRepository, never()).save(any());
    }

    @Test
    @DisplayName("会话不存在：拒绝")
    void unknownSessionIsRejected() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.empty());

        assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));
        verifyNoInteractions(chatGateway);
    }

    @Test
    @DisplayName("已有预测：直接返回旧的，不查消息也不调模型")
    void returnsStoredPrediction() throws Exception {
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID)).thenReturn(Optional.of(
                Instruction.builder().sessionId(SESSION_ID).turnId(TURN_ID).nextInstruction("已有的预测")
                        .createAt(Instant.now()).build()));

        assertEquals("已有的预测", service.next(SESSION_ID, TURN_ID).getData().getNextInstruction());
        verifyNoInteractions(chatGateway, messageRepository, chatTurnRepository);
    }

    @Test
    @DisplayName("同一轮连续问三次：只调一次模型、只写一条库，后两次复用旧结果")
    void repeatedRequestsPersistOnlyOnce() {
        usePersistentStore();

        for (int round = 0; round < 3; round++) {
            assertEquals("帮我补一个单元测试", service.next(SESSION_ID, TURN_ID).getData().getNextInstruction());
        }

        assertEquals(1, saveCount.get(), "同一轮只允许写一次库");
        verify(chatGateway, times(1)).chat(any(), any(), any());
        verify(messageRepository, times(1)).findByTurnIds(SESSION_ID, List.of(TURN_ID));
    }

    @Test
    @DisplayName("同一轮 8 个并发请求：模型只调一次、库里只有一条，后到者返回空而不是排队等模型")
    void concurrentRequestsShareOneGeneration() throws Exception {
        usePersistentStore();
        CountDownLatch modelEntered = new CountDownLatch(1);
        when(chatGateway.chat(any(), any(), any())).thenAnswer(invocation -> {
            modelEntered.countDown();
            // 卡住模型响应，保证其它线程都在「生成中」这个窗口里撞进来。
            assertTrue(modelEntered.await(5, TimeUnit.SECONDS));
            Thread.sleep(150);
            return response("并发下也只该有一条");
        });

        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        int answered = 0;
        try {
            CountDownLatch startLine = new CountDownLatch(1);
            List<Future<Result<InstructionVO>>> futures = new ArrayList<>();
            for (int index = 0; index < threads; index++) {
                futures.add(pool.submit(() -> {
                    assertTrue(startLine.await(5, TimeUnit.SECONDS));
                    return service.next(SESSION_ID, TURN_ID);
                }));
            }
            startLine.countDown();
            for (Future<Result<InstructionVO>> future : futures) {
                InstructionVO vo = future.get(10, TimeUnit.SECONDS).getData();
                if (vo == null) {
                    continue;
                }
                answered++;
                assertEquals("并发下也只该有一条", vo.getNextInstruction(), "并发下不许出现第二个版本的预测");
            }
        } finally {
            pool.shutdownNow();
        }

        assertTrue(answered > 0, "并发里至少要有一个请求拿到预测");
        verify(chatGateway, times(1)).chat(any(), any(), any());
        assertEquals(1, saveCount.get(), "并发请求只允许落一条预测");
    }

    @Test
    @DisplayName("双检锁：锁内读到别的线程刚写好的结果，不调模型也不重复落库")
    void predictionStoredWhileWaitingIsReused() {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID)))
                .thenReturn(completedTurnMessages("把指令预测接上", "已经接好了"));
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID))
                .thenReturn(Optional.empty(), Optional.of(stored("锁内读到的旧预测")));

        assertEquals("锁内读到的旧预测", service.next(SESSION_ID, TURN_ID).getData().getNextInstruction());
        verifyNoInteractions(chatGateway);
        verify(instructionRepository, never()).save(any());
    }

    @Test
    @DisplayName("双检锁：窗口期里下一条已入队，放弃生成")
    void pendingChatArrivedWhileWaitingAbortsGeneration() {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID)))
                .thenReturn(completedTurnMessages("把指令预测接上", "已经接好了"));
        // 进方法时队列还空，拿到生成权之后再查就已经有接力消息了。
        when(pendingChats.hasPending(SESSION_ID)).thenReturn(false, true);

        assertNull(service.next(SESSION_ID, TURN_ID).getData());
        verifyNoInteractions(chatGateway);
        verify(instructionRepository, never()).save(any());
    }

    @Test
    @DisplayName("双检锁：窗口期里会话已经开跑新一轮，这一轮的预测过时，放弃生成")
    void newerTurnStartedWhileWaitingAbortsGeneration() {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID)))
                .thenReturn(completedTurnMessages("把指令预测接上", "已经接好了"));
        when(chatTurnRepository.findFromId(SESSION_ID, TURN_ID)).thenReturn(List.of(
                turn(ChatTurnStatus.COMPLETED),
                ChatTurn.builder().id(TURN_ID + 1).sessionId(SESSION_ID).status(ChatTurnStatus.RUNNING).build()));

        assertNull(service.next(SESSION_ID, TURN_ID).getData());
        verifyNoInteractions(chatGateway);
        verify(instructionRepository, never()).save(any());
    }

    @Test
    @DisplayName("正在生成时重复进来：当场返回空，不并发调第二次模型")
    void inFlightGenerationRejectsSecondRequest() throws Exception {
        usePersistentStore();
        CountDownLatch modelEntered = new CountDownLatch(1);
        CountDownLatch releaseModel = new CountDownLatch(1);
        when(chatGateway.chat(any(), any(), any())).thenAnswer(invocation -> {
            modelEntered.countDown();
            assertTrue(releaseModel.await(5, TimeUnit.SECONDS));
            return response("生成中的那一条");
        });

        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<InstructionVO> leader = pool.submit(() -> service.next(SESSION_ID, TURN_ID).getData());
            assertTrue(modelEntered.await(5, TimeUnit.SECONDS));

            assertNull(service.next(SESSION_ID, TURN_ID).getData(), "生成中的重复请求必须当场返回空");

            releaseModel.countDown();
            assertEquals("生成中的那一条", leader.get(10, TimeUnit.SECONDS).getNextInstruction());
        } finally {
            pool.shutdownNow();
        }

        verify(chatGateway, times(1)).chat(any(), any(), any());
        assertEquals(1, saveCount.get());
    }

    @Test
    @DisplayName("生成失败也要释放生成权：下一次仍能重新生成")
    void failedGenerationReleasesSlot() {
        usePersistentStore();
        when(chatGateway.chat(any(), any(), any()))
                .thenThrow(new IllegalStateException("网络断了"))
                .thenReturn(response("重试后成功"));

        assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));
        assertEquals("重试后成功", service.next(SESSION_ID, TURN_ID).getData().getNextInstruction());
        verify(chatGateway, times(2)).chat(any(), any(), any());
        assertEquals(1, saveCount.get());
    }

    @Test
    @DisplayName("别的进程抢先落库（唯一索引冲突）：返回先到者的内容，不当成错误")
    void duplicateKeyFromAnotherProcessReusesWinner() {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID)))
                .thenReturn(completedTurnMessages("把指令预测接上", "已经接好了"));
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID))
                .thenReturn(Optional.empty(), Optional.empty(), Optional.of(stored("先到者写下的指令")));
        doThrow(new DuplicateKeyException("ux_instruction_predict_turn"))
                .when(instructionRepository).save(any());

        assertEquals("先到者写下的指令", service.next(SESSION_ID, TURN_ID).getData().getNextInstruction());
        verify(instructionRepository, times(1)).save(any());
    }

    @Test
    @DisplayName("功能未开启（没选预测模型）：返回空，不生成")
    void disabledFeatureReturnsNothing() {
        when(userConfigService.current()).thenReturn(Result.success(UserConfigVO.builder().build()));

        assertNull(service.next(SESSION_ID, TURN_ID).getData());
        verifyNoInteractions(chatGateway, messageRepository, chatTurnRepository);
    }

    @Test
    @DisplayName("队列里还有接力消息：这一轮不预测")
    void pendingQueueSkipsPrediction() {
        when(pendingChats.hasPending(SESSION_ID)).thenReturn(true);

        assertNull(service.next(SESSION_ID, TURN_ID).getData());
        verifyNoInteractions(chatGateway, messageRepository);
    }

    @Test
    @DisplayName("轮次还没终态：返回空，不生成")
    void runningTurnIsNotPredicted() {
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(turn(ChatTurnStatus.RUNNING)));

        assertNull(service.next(SESSION_ID, TURN_ID).getData());
        verifyNoInteractions(chatGateway, messageRepository);
    }

    @Test
    @DisplayName("只有 COMPLETED 才生成：失败/取消/挂起/受理中一律不预测")
    void onlyCompletedTurnIsPredicted() throws Exception {
        // 必须让这一轮「正文齐全」：否则用例会因为「缺正文」而通过，根本区分不出状态闸门是否生效。
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(List.of(
                message(SessionMessageType.USER, userJson("提问")),
                message(SessionMessageType.AI, aiJson(AiMessageEntity.builder().text("回答").build()))));

        for (ChatTurnStatus status : List.of(ChatTurnStatus.FAILED, ChatTurnStatus.CANCELLED,
                ChatTurnStatus.WAITING, ChatTurnStatus.ACCEPTED)) {
            when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(turn(status)));

            assertNull(service.next(SESSION_ID, TURN_ID).getData(), status + " 不该生成预测");
            verifyNoInteractions(chatGateway);
            verify(instructionRepository, never()).save(any());
        }
    }

    @Test
    @DisplayName("用最后一条用户消息与最后一条无工具调用的 AI 正文，并按短请求口径覆盖思考与预算")
    void predictsFromUserAndFinalAgentText() throws Exception {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(List.of(
                message(SessionMessageType.USER, userJson("旧问题")),
                message(SessionMessageType.AI, aiJson(AiMessageEntity.builder().text("旧回答").build())),
                message(SessionMessageType.USER, userJson("把指令预测接上")),
                // 带工具调用的中间态行必须被跳过
                message(SessionMessageType.AI, aiJson(AiMessageEntity.builder().text("正在调用工具")
                        .toolCalls(List.of(new ToolCallRequest("call-1", "read_file", 0, "{}"))).build())),
                message(SessionMessageType.AI, aiJson(AiMessageEntity.builder().text("已经接好了").build()))));

        InstructionVO vo = service.next(SESSION_ID, TURN_ID).getData();

        ArgumentCaptor<ModelConfig> config = ArgumentCaptor.forClass(ModelConfig.class);
        ArgumentCaptor<String> systemPrompt = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(chatGateway).chat(config.capture(), systemPrompt.capture(), content.capture());
        assertEquals(512, config.getValue().getMaxTokens());
        assertEquals(Duration.ofSeconds(30), config.getValue().getTimeout());
        assertFalse(config.getValue().isReturnThinking());
        assertFalse(config.getValue().isSendThinking());
        assertTrue(content.getValue().contains("把指令预测接上"));
        assertTrue(content.getValue().contains("已经接好了"));
        assertFalse(content.getValue().contains("旧问题"));
        assertFalse(content.getValue().contains("正在调用工具"));
        assertTrue(systemPrompt.getValue().contains("预测"));
        assertEquals("帮我补一个单元测试", vo.getNextInstruction());
        verify(instructionRepository).save(any(Instruction.class));
    }

    @Test
    @DisplayName("该轮没有可用的 Agent 终态正文：返回空，不生成")
    void missingFinalAgentTextReturnsNothing() throws Exception {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(List.of(
                message(SessionMessageType.USER, userJson("只有提问"))));

        assertNull(service.next(SESSION_ID, TURN_ID).getData());
        verifyNoInteractions(chatGateway);
        verify(instructionRepository, never()).save(any());
    }

    @Test
    @DisplayName("轮次不属于该会话：直接拒绝")
    void foreignTurnIsRejected() {
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(
                ChatTurn.builder().id(TURN_ID).sessionId(99L).status(ChatTurnStatus.COMPLETED).build()));

        assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));
        verifyNoInteractions(chatGateway);
    }

    @Test
    @DisplayName("模型返回空文本或工具调用：拒绝并给出可读原因")
    void unusableResponseIsRejected() throws Exception {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(List.of(
                message(SessionMessageType.USER, userJson("提问")),
                message(SessionMessageType.AI, aiJson(AiMessageEntity.builder().text("回答").build()))));

        when(chatGateway.chat(any(), any(), any())).thenReturn(response("  "));
        assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));

        ChatResponseEntity toolCall = response("不要用这段");
        toolCall.getAiMessageEntity().setToolCalls(List.of(new ToolCallRequest("call-1", "unexpected", 0, "{}")));
        when(chatGateway.chat(any(), any(), any())).thenReturn(toolCall);
        assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));

        verify(instructionRepository, never()).save(any());
    }

    /**
     * 换成「真能存住、能读回」的假仓储。
     *
     * <p>@BeforeEach 里的空 stub 只能验证「库里已有预测就不重复生成」；要验证重复请求、
     * 并发请求也不会重复生成，必须先让第一次生成的结果真的留在这个假仓储里。</p>
     */
    private void usePersistentStore() {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID)))
                .thenReturn(completedTurnMessages("把指令预测接上", "已经接好了"));
        when(instructionRepository.findBySessionAndTurn(anyLong(), anyLong())).thenAnswer(call -> Optional
                .ofNullable(store.get(key(call.getArgument(0, Long.class), call.getArgument(1, Long.class)))));
        doAnswer(call -> {
            Instruction saved = call.getArgument(0);
            store.put(key(saved.getSessionId(), saved.getTurnId()), saved);
            saveCount.incrementAndGet();
            return null;
        }).when(instructionRepository).save(any());
    }

    private static String key(Long sessionId, Long turnId) {
        return sessionId + ":" + turnId;
    }

    private static Instruction stored(String text) {
        return Instruction.builder().sessionId(SESSION_ID).turnId(TURN_ID).nextInstruction(text)
                .createAt(Instant.now()).build();
    }

    private static List<SessionMessage> completedTurnMessages(String userText, String agentText) {
        try {
            return List.of(message(SessionMessageType.USER, userJson(userText)),
                    message(SessionMessageType.AI, aiJson(AiMessageEntity.builder().text(agentText).build())));
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("测试载荷序列化失败", error);
        }
    }

    private static Session rootSession() {
        return Session.builder().id(SESSION_ID).rootSessionId(Session.ROOT_SESSION_ID).build();
    }

    private static ChatTurn turn(ChatTurnStatus status) {
        return ChatTurn.builder().id(TURN_ID).sessionId(SESSION_ID).status(status).build();
    }

    private static SessionMessage message(SessionMessageType type, String payload) {
        return SessionMessage.builder().type(type).text(payload).build();
    }

    private static String userJson(String text) throws JsonProcessingException {
        return JSON.writeValueAsString(UserMessageEntity.from(text));
    }

    private static String aiJson(AiMessageEntity message) throws JsonProcessingException {
        return JSON.writeValueAsString(message);
    }

    private static ChatResponseEntity response(String text) {
        return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder().text(text).build()).build();
    }
}
