package com.summit.dp.execution.infrastructure.config;

import com.summit.dp.execution.domain.repository.ExecutionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.stereotype.Component;

/**
 * 启动执行收尸钩子：进程崩溃重启后，{@code execution} 表里遗留的 CREATED / RUNNING
 * 执行已没有任何线程负责收尾（框架执行循环随进程一起消失），若不清收，这些执行会
 * 永远停留在「进行中」——既污染「一个会话最多一个进行中执行」的单飞判定，也误导展示。
 * 启动完成时统一收口为 FAILED 终态（未完成是事实）。
 *
 * <p><b>安全边界</b>：只条件更新 {@code status IN (CREATED, RUNNING)}。SUSPENDED 行代表
 * 「已暂停待恢复」，必须保留，误标会让恢复入口消失；COMPLETED / FAILED / CANCELLED 等
 * 终态行不属于本钩子职责，绝不触碰。</p>
 *
 * <p>收口是幂等的条件更新（见 {@link ExecutionRepository#markOrphanRunsFailed()}），
 * 重复启动 / 重复执行无副作用（第二次命中 0 行）。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ExecutionStartupReaper implements ApplicationListener<ApplicationReadyEvent> {

    private final ExecutionRepository executionRepository;

    @Override
    public void onApplicationEvent(@NonNull ApplicationReadyEvent event) {
        int reaped = executionRepository.markOrphanRunsFailed();
        log.info("execution 表遗留 CREATED/RUNNING 已收口为 FAILED，共 {} 行", reaped);
    }
}
