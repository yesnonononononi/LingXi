package com.summit.dp.instruction;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.instruction.application.service.impl.InstructionServiceImpl;
import com.summit.dp.instruction.domain.model.Instruction;
import com.summit.dp.instruction.domain.repository.InstructionRepository;
import com.summit.dp.instruction.infrastructure.persistence.mapper.InstructionMapper;
import com.summit.dp.instruction.infrastructure.repository.InstructionRepositoryImpl;
import com.summit.dp.model.application.service.ModelChatGateway;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.service.UserConfigService;
import com.summit.dp.user_configs.application.vo.UserConfigVO;
import com.summit.dp.workflow.application.chat.PendingChatQueue;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DuplicateKeyException;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 指令预测的落库形态：真实 H2 文件库、真实唯一索引、真实「重启后再问同一轮」。
 *
 * <p>Mockito 造不出「重启」：进程内状态清空而库里的行还在，只有文件库 + 重新构造的
 * SqlSessionFactory / 仓储实例才能证明重启后不会重新调模型。</p>
 */
class InstructionPredictPersistenceTest {

    private static final long SESSION_ID = 7L;
    private static final long TURN_ID = 11L;
    private static final long MODEL_ID = 5L;
    private static final ObjectMapper JSON = new ObjectMapper();

    private H2TestDatabase database;

    @AfterEach
    void cleanUp() {
        if (database != null) {
            database.shutdown();
        }
    }

    @Test
    @DisplayName("同一轮写两次：唯一索引拒绝第二次，库里仍只有一条")
    void uniqueIndexAllowsOnePredictionPerTurn() {
        database = H2TestDatabase.create("instruction-predict");
        InstructionRepository first = repository(database);
        InstructionRepository second = repository(database);

        first.save(instruction("第一份预测"));

        DataAccessException failure = assertThrows(DataAccessException.class,
                () -> second.save(instruction("第二份预测")));
        assertInstanceOf(DuplicateKeyException.class, failure,
                "唯一索引必须落成 DuplicateKeyException（否则业务侧的幂等兜底不会触发），实际="
                        + failure.getClass().getName());
        assertEquals(1, rowCount(), "同一轮只该有一行");
        assertEquals("第一份预测", second.findBySessionAndTurn(SESSION_ID, TURN_ID)
                .orElseThrow().getNextInstruction());
    }

    @Test
    @DisplayName("重启后再问同一轮：直接返回库里的旧预测，模型仍只被调一次")
    void restartReusesStoredPrediction() {
        database = H2TestDatabase.create("instruction-predict-restart");
        ModelChatGateway gateway = mock(ModelChatGateway.class);
        when(gateway.chat(any(), any(), any())).thenReturn(
                ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder().text("重启前生成的指令").build())
                        .build());

        InstructionServiceImpl beforeRestart = service(repository(database), gateway);
        assertEquals("重启前生成的指令", beforeRestart.next(SESSION_ID, TURN_ID).getData().getNextInstruction());
        assertEquals(1, rowCount());

        // 「重启」= 新的一套 SqlSessionFactory + 新仓储实例；进程内的生成权占位也不存在。
        InstructionServiceImpl afterRestart = service(repository(database), gateway);
        assertEquals("重启前生成的指令", afterRestart.next(SESSION_ID, TURN_ID).getData().getNextInstruction());

        verify(gateway, times(1)).chat(any(), any(), any());
        assertEquals(1, rowCount(), "重启后不得再写一行");
    }

    private static InstructionRepository repository(H2TestDatabase database) {
        SqlSessionFactory factory = database.sessionFactory(InstructionMapper.class);
        return new InstructionRepositoryImpl(H2TestDatabase.sqlSession(factory).getMapper(InstructionMapper.class));
    }

    private InstructionServiceImpl service(InstructionRepository repository, ModelChatGateway gateway) {
        SessionRepository sessions = mock(SessionRepository.class);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).rootSessionId(Session.ROOT_SESSION_ID).build()));
        MessageRepository messages = mock(MessageRepository.class);
        when(messages.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(completedTurnMessages());
        ChatTurnRepository turns = mock(ChatTurnRepository.class);
        when(turns.findById(TURN_ID)).thenReturn(Optional.of(
                ChatTurn.builder().id(TURN_ID).sessionId(SESSION_ID).status(ChatTurnStatus.COMPLETED).build()));
        PendingChatQueue pendingChats = mock(PendingChatQueue.class);
        when(pendingChats.hasPending(SESSION_ID)).thenReturn(false);
        UserConfigService userConfigs = mock(UserConfigService.class);
        when(userConfigs.current()).thenReturn(Result.success(
                UserConfigVO.builder().predicateModelId(MODEL_ID).build()));
        SettingsProvider settings = mock(SettingsProvider.class);
        when(settings.current()).thenReturn(Optional.empty());
        ModelService models = mock(ModelService.class);
        when(models.runtimeConfig(any(), any())).thenReturn(ModelConfig.builder()
                .baseUrl("https://example.invalid/v1").apiKey("key").modelName("predict-model").build());
        return new InstructionServiceImpl(repository, sessions, messages, turns, pendingChats, userConfigs, models,
                settings, gateway, JSON);
    }

    private static List<SessionMessage> completedTurnMessages() {
        try {
            return List.of(
                    SessionMessage.builder().type(SessionMessageType.USER)
                            .text(JSON.writeValueAsString(UserMessageEntity.from("把指令预测接上"))).build(),
                    SessionMessage.builder().type(SessionMessageType.AI)
                            .text(JSON.writeValueAsString(AiMessageEntity.builder().text("已经接好了").build()))
                            .build());
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("测试载荷序列化失败", error);
        }
    }

    private static Instruction instruction(String text) {
        return Instruction.builder()
                .sessionId(SESSION_ID)
                .turnId(TURN_ID)
                .modelId(MODEL_ID)
                .nextInstruction(text)
                .createAt(Instant.now())
                .updateAt(Instant.now())
                .build();
    }

    private int rowCount() {
        return Integer.parseInt(database.queryString("SELECT COUNT(*) FROM instruction_predict"));
    }
}
