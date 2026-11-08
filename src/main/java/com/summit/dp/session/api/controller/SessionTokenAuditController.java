package com.summit.dp.session.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.service.SessionTokenAuditQueryService;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 会话级 token 审计查询端点。
 *
 * <p>与 {@link SessionReadController} 同风格：{@code @RestController} + {@code Result<T>} 信封，
 * 不在这里做任何口径计算，全部下沉到领域与查询服务。</p>
 */
@RestController
@RequestMapping("/session")
@RequiredArgsConstructor
public class SessionTokenAuditController {

    private final SessionTokenAuditQueryService queryService;

    /**
     * 读当前会话的 token 构成快照 + 实时总量。
     *
     * <p>{@code {id}} 传根会话或子会话均可：审计按会话存，不向根会话聚合
     * （与 {@code /session/{id}/tree} 的归属语义一致）。</p>
     *
     * @param id 会话标识
     * @return 统一信封包裹的审计视图
     */
    @GetMapping("/{id}/token-audit")
    public Result<SessionTokenAuditVO> tokenAudit(@PathVariable Long id) {
        return queryService.find(id);
    }
}
