package com.summit.dp.turn.infrastructure.config;

import com.summit.dp.turn.application.service.ChatTurnService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.stereotype.Component;

/**
 * 轮次收尸钩子：与 {@code ExecutionStartupReaper} 同时机、同口径。
 *
 * <p><b>为什么必须有</b>：进程崩溃重启后，仍停留在 ACCEPTED / RUNNING 的轮次没有任何线程再
 * 负责收尾；不收口就会永远显示「执行中」。这与框架 execution 的孤儿收尸是**同一件事的两半** ——
 * 只收口 execution 而不收口 chat_turn，历史里就会出现「轮次说在跑、执行早就没了」。</p>
 *
 * <p><b>安全边界</b>：只命中 ACCEPTED / RUNNING。WAITING 代表「挂起待审批 / 待恢复」，
 * 必须保留 —— 误标失败会让「待恢复」入口消失，用户再也恢复不了那次执行。
 * 已终态的行同样不在条件内，幂等。</p>
 *
 * <p>两个收尸钩子互相独立（不同表、无先后依赖），因此各自监听启动完成事件即可。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ChatTurnStartupReaper implements ApplicationListener<ApplicationReadyEvent> {

    private final ChatTurnService chatTurnService;

    @Override
    public void onApplicationEvent(@NonNull ApplicationReadyEvent event) {
        int reaped = chatTurnService.reapOrphans();
        log.info("chat_turn 表遗留 ACCEPTED/RUNNING 已收口为 FAILED，共 {} 行", reaped);
    }
}
