package com.summit.dp.agent.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.vo.AgentVO;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

public interface ChatService {
    Result<String> chat(ChatCommand command);

    SseEmitter chatStream(ChatCommand command);

    /** 不可恢复地终止该根会话当前运行的主 loop 与全部子 loop。 */
    void stop(Long sessionId);

    /** 协作式暂停当前正在运行的 loop；已结束的执行不接受暂停。 */
    void suspend(Long sessionId);

    /** Resume the latest suspended execution of this session from its checkpoint. */
    Result<String> resume(Long sessionId);

}
