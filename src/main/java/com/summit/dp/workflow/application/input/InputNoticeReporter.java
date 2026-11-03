package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/** 报告与去重标识一起提交，刷新后仍能看到保留原因。 */
@Component
@RequiredArgsConstructor
@Slf4j
public class InputNoticeReporter {
    public static final String PREFIX = "待处理输入已保留：";
    private final ObjectProvider<ExecutionRepository> executions;
    private final ChatTurnRepository turns;

    @Transactional
    public void reportQueryFailure(long executionId, String reason) {
        ChatTurn turn = turns.findByExecutionId(executionId).orElse(null);
        if (turn == null) return;
        String notice = PREFIX + reason + "；请稍后重试。";
        if (turn.getErrorReason() != null && turn.getErrorReason().contains(notice)) return;
        turn.recordInputNotice(notice);
        Long rootSessionId = turn.getParentTurnId() == null ? turn.getSessionId()
                : turns.findById(turn.getParentTurnId()).orElseThrow(ClientException::new).getSessionId();
        turns.updateById(turn, rootSessionId);
    }

    @Transactional
    public void report(Execution execution, String batchKey, String reason) {
        if (batchKey.equals(InputAutomationPolicy.attributes(execution).get(InputAutomationPolicy.LAST_REPORT))) return;
        String notice = PREFIX + reason + "；请在原会话中主动继续。";
        ChatTurn turn = turns.findByExecutionId(Long.valueOf(execution.getId())).orElse(null);
        if (turn != null) {
            turn.recordInputNotice(notice);
            turns.updateById(turn, ExecutionAttributes.mailboxSessionId(InputAutomationPolicy.attributes(execution)));
        }
        InputAutomationPolicy.putAttribute(execution, InputAutomationPolicy.LAST_REPORT, batchKey);
        executions.getObject().save(execution);
        log.warn("保留待处理输入: executionId={}, reason={}", execution.getId(), reason);
    }
}
