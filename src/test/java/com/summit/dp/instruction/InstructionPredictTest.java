package com.summit.dp.instruction;

import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
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
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.service.UserConfigService;
import com.summit.dp.user_configs.application.vo.UserConfigVO;
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

/** 指令预测：输入装配、模型调用口径、缓存复用与失败语义。 */
class InstructionPredictTest {

    private static final long SESSION_ID = 7L;
    private static final long TURN_ID = 11L;
    private static final long PREDICATE_MODEL_ID = 5L;

    private final InstructionRepository instructionRepository = mock(InstructionRepository.class);
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final UserConfigService userConfigService = mock(UserConfigService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final ModelChatGateway chatGateway = mock(ModelChatGateway.class);
    private final InstructionServiceImpl service = new InstructionServiceImpl(instructionRepository, messageRepository,
            userConfigService, modelService, settingsProvider, chatGateway);

    @BeforeEach
    void setUp() {
        when(userConfigService.current()).thenReturn(Result.success(
                UserConfigVO.builder().predicateModelId(PREDICATE_MODEL_ID).build()));
        when(settingsProvider.current()).thenReturn(Optional.empty());
        when(modelService.runtimeConfig(eq(PREDICATE_MODEL_ID), any())).thenReturn(ModelConfig.builder()
                .baseUrl("https://example.invalid/v1").apiKey("key").modelName("predict-model")
                .maxTokens(32768).returnThinking(true).sendThinking(true).build());
        when(chatGateway.chat(any(), any(), any())).thenReturn(response("帮我补一个单元测试"));
    }

    @Test
    @DisplayName("用最后一轮的用户消息与 Agent 正文，并按短请求口径覆盖思考与预算")
    void predictsFromLastUserAndAgentTextWithCompactBudget() {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(List.of(
                message(SessionMessageType.USER, "旧问题"),
                message(SessionMessageType.AI, "旧回答"),
                message(SessionMessageType.USER, "把指令预测接上"),
                message(SessionMessageType.AI, "已经接好了")));

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
        assertTrue(systemPrompt.getValue().contains("预测"));
        assertEquals("帮我补一个单元测试", vo.getNextInstruction());
        verify(instructionRepository).save(any(Instruction.class));
    }

    @Test
    @DisplayName("同一轮已有结果：直接复用，不再调用模型")
    void reusesStoredPrediction() {
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID)).thenReturn(Optional.of(
                Instruction.builder().sessionId(SESSION_ID).turnId(TURN_ID).nextInstruction("已有的预测")
                        .createAt(Instant.now()).build()));

        assertEquals("已有的预测", service.next(SESSION_ID, TURN_ID).getData().getNextInstruction());
        verifyNoInteractions(chatGateway, messageRepository);
    }

    @Test
    @DisplayName("没配置预测模型：直接拒绝，不发起任何查询与调用")
    void missingPredicateModelIsRejected() {
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID)).thenReturn(Optional.empty());
        when(userConfigService.current()).thenReturn(Result.success(UserConfigVO.builder().build()));

        ClientException error = assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));

        assertTrue(error.getMessage().contains("没有配置指令预测模型"));
        verifyNoInteractions(chatGateway, messageRepository);
    }

    @Test
    @DisplayName("该轮还没有 Agent 正文：不预测")
    void missingAgentTextIsRejected() {
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID)).thenReturn(Optional.empty());
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID)))
                .thenReturn(List.of(message(SessionMessageType.USER, "只有提问")));

        assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));
        verifyNoInteractions(chatGateway);
    }

    @Test
    @DisplayName("模型返回空文本或工具调用：拒绝并给出可读原因")
    void unusableResponseIsRejected() {
        when(instructionRepository.findBySessionAndTurn(SESSION_ID, TURN_ID)).thenReturn(Optional.empty());
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(List.of(
                message(SessionMessageType.USER, "提问"), message(SessionMessageType.AI, "回答")));

        when(chatGateway.chat(any(), any(), any())).thenReturn(response("  "));
        assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));

        ChatResponseEntity toolCall = response("不要用这段");
        toolCall.getAiMessageEntity().setToolCalls(List.of(new ToolCallRequest("call-1", "unexpected", 0, "{}")));
        when(chatGateway.chat(any(), any(), any())).thenReturn(toolCall);
        assertThrows(ClientException.class, () -> service.next(SESSION_ID, TURN_ID));

        verify(instructionRepository, never()).save(any());
    }

    private static SessionMessage message(SessionMessageType type, String text) {
        return SessionMessage.builder().type(type).text(text).build();
    }

    private static ChatResponseEntity response(String text) {
        return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder().text(text).build()).build();
    }
}
