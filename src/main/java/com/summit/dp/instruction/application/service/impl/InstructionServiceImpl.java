package com.summit.dp.instruction.application.service.impl;

import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.instruction.api.vo.InstructionVO;
import com.summit.dp.instruction.application.service.InstructionService;
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
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.user_configs.application.vo.UserConfigVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * 指令预测：拿上一轮「用户提问 + Agent 正文」让模型猜用户下一句会说什么。
 *
 * <p>模型调用走 {@link ModelChatGateway}，与本项目其它一次性文本生成共用同一入口；
 * 预测模型是用户设置里的独立选项，空表示功能未启用。</p>
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
    private final MessageRepository messageRepository;
    private final UserConfigService userConfigService;
    private final ModelService modelService;
    private final SettingsProvider settingsProvider;
    private final ModelChatGateway chatGateway;

    @Override
    public Result<InstructionVO> next(Long sessionId, Long turnId) {
        throwIf(sessionId == null || turnId == null, "会话或轮次标识不能为空");
        // 同一轮只预测一次：结果落库后直接复用，重复点击不再消耗模型调用。
        Optional<Instruction> cached = instructionRepository.findBySessionAndTurn(sessionId, turnId);
        if (cached.isPresent()) {
            return Result.success(toVO(cached.get()));
        }

        UserConfigVO userConfig = userConfigService.current().getData();
        Long predicateModelId = userConfig == null ? null : userConfig.getPredicateModelId();
        throwIf(predicateModelId == null, "当前没有配置指令预测模型，请先在设置中选择或关闭此功能");

        List<SessionMessage> messages = messageRepository.findByTurnIds(sessionId, List.of(turnId));
        String userText = lastText(messages, SessionMessageType.USER);
        String agentText = lastText(messages, SessionMessageType.AI);
        throwIf(userText == null, "当前轮次没有用户提问，无法预测下一步指令");
        throwIf(agentText == null, "当前轮次还没有 Agent 回复正文，无法预测下一步指令");

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

    @Override
    public Result<InstructionVO> queryById(Long instructionId) {
        throwIf(instructionId == null, "指令标识不能为空");
        Instruction instruction = instructionRepository.findById(instructionId)
                .orElseThrow(() -> new ClientException("指令预测结果不存在: " + instructionId));
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

    /** 同一轮可能有多条同类型消息（补充要求、重发），取最后一条。 */
    private String lastText(List<SessionMessage> messages, SessionMessageType type) {
        String text = null;
        for (SessionMessage message : messages) {
            if (message.getType() == type && message.getText() != null && !message.getText().isBlank()) {
                text = message.getText();
            }
        }
        return text;
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
