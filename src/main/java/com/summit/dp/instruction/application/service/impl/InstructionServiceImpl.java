package com.summit.dp.instruction.application.service.impl;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.instruction.api.vo.InstructionVO;
import com.summit.dp.instruction.application.service.InstructionService;
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
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.user_configs.application.vo.UserConfigVO;
import com.summit.dp.workflow.application.chat.PendingChatQueue;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * 指令预测：拿已终态轮次的「用户提问 + Agent 终态正文」让模型猜用户下一句会说什么。
 *
 * <p>对外只有一个入口 {@code next}：有旧的就返回旧的，没有才生成 —— 每个轮次只产出一条预测。
 * 不生成的情况（功能未开启、轮次未正常完成、队列里还有接力消息、子会话）统一返回空，不当成错误。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class InstructionServiceImpl implements InstructionService {

    /** 预测只输出一句话，输出预算与压缩模型的 32768 区分开。 */
    private static final int PREDICT_MAX_TOKENS = 512;
    private static final Duration PREDICT_TIMEOUT = Duration.ofSeconds(30);
    /** Agent 正文可能几万字，超出部分对预测没有价值，只取开头。 */
    private static final int MAX_CONTEXT_CHARS = 8_000;
    private static final String SYSTEM_PROMPT = """
            你负责预测用户下一步会对 Agent 说什么。用户消息是上一轮的提问，Agent 回复是上一轮的回答。
            结合这两段内容判断对话接下来最可能的走向，写出用户紧接着会提出的下一条指令。
            只输出指令正文，一句话，保持用户原本的语言和称呼习惯。
            不要解释理由，不要编号、引号或代码围栏；无法判断时输出空字符串。
            """;

    private final InstructionRepository instructionRepository;
    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;
    private final ChatTurnRepository chatTurnRepository;
    private final PendingChatQueue pendingChats;
    private final UserConfigService userConfigService;
    private final ModelService modelService;
    private final SettingsProvider settingsProvider;
    private final ModelChatGateway chatGateway;
    private final ObjectMapper json;

    @Override
    public Result<InstructionVO> next(Long sessionId, Long turnId) {
        throwIf(sessionId == null || turnId == null, "会话或轮次标识不能为空");
        // 子会话是委派出来的执行体，用户不会在里面继续输入；必须在查旧预测之前拒绝，
        // 否则子会话里历史遗留的预测行照样会被返回。
        Session session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new ClientException("会话不存在: " + sessionId));
        throwIf(session.isSubSession(), "子会话不支持指令预测");
        // 不论新旧，这一轮只返回一条：已有预测直接复用，不再花模型调用。
        Optional<Instruction> existing = instructionRepository.findBySessionAndTurn(sessionId, turnId);
        if (existing.isPresent()) {
            return Result.success(toVO(existing.get()));
        }

        UserConfigVO userConfig = userConfigService.current().getData();
        Long predicateModelId = userConfig == null ? null : userConfig.getPredicateModelId();
        // 功能没开（或模型没选）：前端只是问一句，返回空即可。
        if (predicateModelId == null) {
            return Result.success(null);
        }

        // 队列里还有待发送消息：这一轮会被接力，用户的「下一句」已经存在，预测没有意义。
        if (pendingChats.hasPending(sessionId)) {
            return Result.success(null);
        }

        ChatTurn turn = chatTurnRepository.findById(turnId)
                .orElseThrow(() -> new ClientException("轮次不存在: " + turnId));
        throwIf(!sessionId.equals(turn.getSessionId()), "轮次不属于该会话");
        // 只对「正常完成」的轮次预测：状态只认 chat_turn.status，前端的终态判断只是触发时机。
        // 失败/取消的轮次没有可信的下文 —— 拿错误现场去猜用户下一句，只会把跑歪的对话当成走向。
        if (turn.getStatus() != ChatTurnStatus.COMPLETED) {
            return Result.success(null);
        }

        List<SessionMessage> messages = messageRepository.findByTurnIds(sessionId, List.of(turnId));
        String userText = lastUserText(messages);
        String agentText = finalAgentText(messages);
        if (userText == null || agentText == null) {
            log.warn("指令预测跳过: reason=缺少用户消息或 Agent 终态正文, sessionId={}, turnId={}", sessionId, turnId);
            return Result.success(null);
        }

        String prediction = predict(predicateModelId, userText, agentText);
        Instruction instruction = Instruction.builder()
                .sessionId(sessionId)
                .turnId(turnId)
                .modelId(predicateModelId)
                .nextInstruction(prediction)
                .createAt(Instant.now())
                .updateAt(Instant.now())
                .build();
        try {
            instructionRepository.save(instruction);
        } catch (DuplicateKeyException collision) {
            // 同一轮并发预测：先到者已落库，复用它的结果，别让用户看到系统错误。
            return Result.success(toVO(instructionRepository.findBySessionAndTurn(sessionId, turnId)
                    .orElse(instruction)));
        }
        return Result.success(toVO(instruction));
    }

    private String predict(Long modelId, String userText, String agentText) {
        SettingsView settings = settingsProvider.current().orElse(null);
        // 预测不是对话：不回传思考、只给一句话的预算，超时也按短请求收敛。
        ModelConfig config = modelService.runtimeConfig(modelId, settings).toBuilder()
                .returnThinking(false)
                .sendThinking(false)
                .maxTokens(PREDICT_MAX_TOKENS)
                .timeout(PREDICT_TIMEOUT)
                .build();
        String content = "用户消息：\n" + truncate(userText) + "\n\nAgent 回复正文：\n" + truncate(agentText);
        ChatResponseEntity response;
        try {
            response = chatGateway.chat(config, SYSTEM_PROMPT, content);
        } catch (Exception error) {
            log.warn("指令预测失败: modelId={}", modelId, error);
            throw new ClientException("指令预测失败，请检查预测模型连接后重试");
        }
        AiMessageEntity message = response == null ? null : response.getAiMessageEntity();
        throwIf(message == null || message.getToolCalls() != null && !message.getToolCalls().isEmpty(),
                "预测模型返回了工具调用，未生成可用指令，请重试");
        throwIf(response.getMeta() != null && response.getMeta().getFinishReason() == ChatResponseEntity.FinishReason.LENGTH,
                "预测结果超过模型输出限制，请调大预测模型的输出上限后重试");
        throwIf(message.text() == null || message.text().isBlank(), "预测模型未返回可用的指令，请重试");
        return message.text().strip();
    }

    /** USER 行载荷是序列化后的 UserMessageEntity，取该轮最后一条非空文本。 */
    private String lastUserText(List<SessionMessage> messages) {
        for (int index = messages.size() - 1; index >= 0; index--) {
            SessionMessage message = messages.get(index);
            if (message.getType() != SessionMessageType.USER) {
                continue;
            }
            UserMessageEntity user = parse(message.getText(), UserMessageEntity.class);
            if (user != null && user.text() != null && !user.text().isBlank()) {
                return user.text();
            }
        }
        return null;
    }

    /**
     * Agent 正文：该轮最后一条「无工具调用」的 AI 行文本。
     *
     * <p>工具循环里每次模型响应都会落一行 AI，带 toolCalls 的那些是中间态，
     * 拿它们当正文会把工具调用参数喂给预测模型。</p>
     */
    private String finalAgentText(List<SessionMessage> messages) {
        for (int index = messages.size() - 1; index >= 0; index--) {
            SessionMessage message = messages.get(index);
            if (message.getType() != SessionMessageType.AI) {
                continue;
            }
            AiMessageEntity ai = parse(message.getText(), AiMessageEntity.class);
            if (ai == null || ai.getToolCalls() != null && !ai.getToolCalls().isEmpty()) {
                continue;
            }
            if (ai.text() != null && !ai.text().isBlank()) {
                return ai.text();
            }
        }
        return null;
    }

    /** 历史行可能是脏载荷；解析失败只跳过该行，不让整次预测失败。 */
    private <T> T parse(String content, Class<T> type) {
        if (content == null || content.isBlank()) {
            return null;
        }
        try {
            return json.readValue(content, type);
        } catch (JsonProcessingException error) {
            log.warn("指令预测跳过无法解析的消息行: type={}", type.getSimpleName());
            return null;
        }
    }

    private String truncate(String text) {
        return text.length() <= MAX_CONTEXT_CHARS ? text : text.substring(0, MAX_CONTEXT_CHARS);
    }

    private InstructionVO toVO(Instruction instruction) {
        return InstructionVO.builder()
                .sessionId(instruction.getSessionId())
                .turnId(instruction.getTurnId())
                .nextInstruction(instruction.getNextInstruction())
                .build();
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }
}
