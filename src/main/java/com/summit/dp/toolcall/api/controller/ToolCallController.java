package com.summit.dp.toolcall.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionCommand;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionReceipt;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionRequest;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.application.service.impl.VersionedToolCallDecisionService;
import com.summit.dp.shared.vo.ToolCallVO;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;

/**
 * 工具调用接口：读侧查询 + 决策提交。
 */
@RestController
@RequestMapping("/tool-call")
@RequiredArgsConstructor
@Tag(name = "tool-call接口", description = "工具调用查询与决策")
public class ToolCallController {

    private final ToolCallService toolCallService;
    /** v2 版本化决策入口；与 v1 SSE 入口并存，各自独立。 */
    private final VersionedToolCallDecisionService versionedDecisionService;

    /**
     * 提交决策结论：批准 / 拒绝 / 作答一次待决策的卡片。
     *
     * <p>结论落定后恢复被暂停的执行并转为异步，恢复期间 loop 产生的全部运行时事件
     * 经 SSE 实时下发，执行结束（含失败）后流关闭。校验失败（工具调用不存在等）发生在建流之前，
     * 此时返回普通 JSON 的 {@code Result} 错误体。</p>
     */
    @Operation(summary = "提交工具调用决策结论")
    @PostMapping("/decide")
    public SseEmitter decide(@RequestBody ToolCallDecisionRequest request) {
        return toolCallService.decide(request.conversationId(), request.toolCallId(),
                request.isApproved(), request.text());
    }

    /**
     * v2 决策入口：JSON 回执，不建 SSE 连接。
     *
     * <p><b>与 v1 的关系</b>：v1 的 {@code /decide} 保留给旧前端。v2 用动作判别
     * （APPROVE / REJECT / ANSWER）而不是 {@code approved} 布尔，并带 {@code expectedVersion}
     * 与 {@code commandId}，因此两套接口不能对同一张卡片混用。</p>
     */
    @Operation(summary = "提交工具调用决策（v2 版本化回执）")
    @PostMapping("/decisions")
    public Result<ToolCallDecisionReceipt> decideCommand(@RequestBody ToolCallDecisionCommand request) {
        return Result.success(versionedDecisionService.decide(request));
    }

    /** 按 {@code toolCallId} 查询聚合视图（前端收到 {@code CARD_PENDING} 后拉取卡片载荷）。 */
    @Operation(summary = "按 id 查询工具调用")
    @GetMapping("/{toolCallId}")
    public Result<ToolCallVO> findById(@PathVariable String toolCallId) {
        return Result.success(toolCallService.findById(toolCallId).orElse(null));
    }

    /** 按会话查询工具调用列表（按创建顺序升序）。 */
    @Operation(summary = "按会话查询工具调用列表")
    @GetMapping("/query")
    public Result<List<ToolCallVO>> listByConversation(@RequestParam Long conversationId) {
        return Result.success(toolCallService.listByConversationId(conversationId));
    }
}
