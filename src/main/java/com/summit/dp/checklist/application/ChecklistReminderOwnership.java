package com.summit.dp.checklist.application;

import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Objects;

/** 旧执行仍在运行或挂起时不能抢占；已终结或清理的执行才允许让位。 */
@Component
@RequiredArgsConstructor
public class ChecklistReminderOwnership {
    private final ExecutionQueryService executionQueries;

    public void requireAvailable(long sessionId, long executionId) {
        for (ExecutionQueryService.ActiveExecution active : executionQueries.activeBySession(List.of(sessionId))) {
            throwIf(!Objects.equals(active.sessionId(), sessionId), "执行归属查询与当前会话不一致");
            throwIf(!Objects.equals(active.executionId(), executionId),
                    "当前会话还有尚未终结的执行，不能接管清单提醒");
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
