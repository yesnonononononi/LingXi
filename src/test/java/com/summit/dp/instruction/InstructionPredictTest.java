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
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
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

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

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
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final PendingChatQueue pendingChats = mock(PendingChatQueue.class);
    private final UserConfigService userConfigService = mock(UserConfigService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final ModelChatGateway chatGateway = mock(ModelChatGateway.class);
    private final InstructionServiceImpl service = new InstructionServiceImpl(instructionRepository, messageRepository,
            chatTurnRepository, pendingChats, userConfigService, modelService, settingsProvider, chatGateway, JSON);

    @BeforeEach
    void setUp() {
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
    @DisplayName("已有预测：直接返回旧的，不查消息也不调模型")
    void returnsStoredPrediction() throws Exception {
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID)).thenReturn(Optional.of(
                Instruction.builder().sessionId(SESSION_ID).turnId(TURN_ID).nextInstruction("已有的预测")
                        .createAt(Instant.now()).build()));

        assertEquals("已有的预测", service.next(SESSION_ID, TURN_ID).getData().getNextInstruction());
        verifyNoInteractions(chatGateway, messageRepository, chatTurnRepository);
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
