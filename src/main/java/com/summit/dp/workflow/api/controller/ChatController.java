package com.summit.dp.workflow.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.shared.vo.ContextCompactionVO;
import com.summit.dp.workflow.api.request.ChatRequest;
import com.summit.dp.workflow.application.chat.*;
import com.summit.dp.workflow.application.compact.ContextCompactionService;
import com.summit.dp.workflow.application.input.ResumeSupplementCommand;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.application.pending.PendingAttachmentContent;
import com.summit.dp.workflow.application.pending.PendingTaskSnapshot;
import com.summit.dp.workflow.application.pending.PendingTaskUpdate;
import com.summit.dp.workflow.application.input.ResumeSupplementService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Objects;

@RestController
@RequestMapping("/a")
@Tag(name = "chat接口", description = "会话聊天入口")
public class ChatController {
    private final ChatService chatService;
    private final ResumeSupplementService resumeSupplementService;
    private final ContextCompactionService contextCompactionService;

    public ChatController(ChatService chatService, ResumeSupplementService resumeSupplementService,
                          ContextCompactionService contextCompactionService) {
        this.chatService = chatService;
        this.resumeSupplementService = resumeSupplementService;
        this.contextCompactionService = contextCompactionService;
    }

    @GetMapping("/completion/limits")
    public Result<ChatLimitsVO> limits() {
        return Result.success(new ChatLimitsVO(SessionMessage.MAX_IMAGE_COUNT));
    }

    @Operation(summary = "文本交流")
    @PostMapping(value = "/completion", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<String> chat(
            @ModelAttribute ChatRequest chatRequest
            ){
        return chatService.chat(command(chatRequest));
    }

    @Operation(summary = "受理聊天请求或加入待发送队列")
    @PostMapping(value = "/completion/commands", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<ChatAcceptanceVO> acceptCommand(@ModelAttribute ChatRequest chatRequest) {
        return chatService.acceptCommand(command(chatRequest));
    }

    @GetMapping("/completion/{sessionId}/pending")
    public Result<PendingTaskSnapshot> pendingCommands(@PathVariable long sessionId) {
        return Result.success(chatService.pendingCommands(sessionId));
    }

    @DeleteMapping("/completion/{sessionId}/pending/{pendingId}")
    public Result<Void> cancelPendingCommand(@PathVariable long sessionId, @PathVariable String pendingId) {
        chatService.cancelPendingCommand(sessionId, pendingId);
        return Result.success();
    }

    @PostMapping("/completion/{sessionId}/pending/resume")
    public Result<Void> resumePendingCommands(@PathVariable long sessionId) {
        chatService.resumePendingCommands(sessionId);
        return Result.success();
    }

    /** 单条「继续」：只放行这一条，不把队列里别的失败任务一起带上。 */
    @Operation(summary = "让某一条待发送消息继续发送")
    @PostMapping("/completion/{sessionId}/pending/{pendingId}/confirm")
    public Result<Void> confirmPendingCommand(@PathVariable long sessionId, @PathVariable String pendingId) {
        chatService.confirmPendingCommand(sessionId, pendingId);
        return Result.success();
    }

    /**
     * 原地修改一条待发送消息：文本、保留哪些已上传图片、再补哪些新图，以及模型 / 执行体 / 计划模式。
     *
     * <p>{@code keepAttachmentIds} 缺省 = 附件不动；显式给出 = 只保留列出的那些（空表示全丢）。
     * 用「缺省」而不是「空列表」表达「不动」，是因为表单里漏传字段与传空值在
     * 客户端几乎无法可靠区分，而误判成「全丢」会直接删掉用户刚传的图。</p>
     *
     * <p>{@code modelId} / {@code agentId} / {@code requirePlan} 反过来是**必填的整笔覆盖**：
     * 编辑面板总能算出当前界面的选择，把它们做成可选只会让「没传」与「清空」混为一谈，
     * 于是界面上显示的模型与真正派发的模型悄悄不一致。空串表示不指定（用预设/会话默认）。</p>
     */
    @Operation(summary = "原地修改待发送消息")
    @PutMapping(value = "/completion/{sessionId}/pending/{pendingId}", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<Void> updatePendingCommand(@PathVariable long sessionId, @PathVariable String pendingId,
                                             @RequestParam(required = false) String input,
                                             @RequestParam(required = false) List<String> keepAttachmentIds,
                                             @RequestParam(name = "image", required = false) List<MultipartFile> images,
                                             @RequestParam String modelId,
                                             @RequestParam String agentId,
                                             @RequestParam boolean requirePlan) {
        chatService.updatePendingCommand(sessionId, pendingId, new PendingTaskUpdate(
                input, keepAttachmentIds, images, requirePlan,
                parseOptionalId(modelId, "模型标识不合法"), parseOptionalId(agentId, "执行体标识不合法")));
        return Result.success();
    }

    /** 表单里的空串表示「不指定」，不能当成 0 或解析失败。 */
    private static Long parseOptionalId(String raw, String err) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException invalid) {
            throw new ClientException(err + ": " + raw);
        }
    }

    /**
     * 读取一条排队附件的原字节：面板缩略图与「回填编辑」共用。
     *
     * <p>走独立接口而不是塞进快照：快照每秒轮询，图片字节必须按需懒加载。</p>
     */
    @Operation(summary = "读取待发送图片")
    @GetMapping("/completion/{sessionId}/pending/{pendingId}/attachments/{attachmentId}")
    public ResponseEntity<byte[]> pendingAttachment(@PathVariable long sessionId, @PathVariable String pendingId,
                                                    @PathVariable String attachmentId) {
        PendingAttachmentContent content = chatService.readPendingAttachment(sessionId, pendingId, attachmentId);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(content.mime()))
                .body(content.data());
    }

    /**
     * 重发：按 checkpoint 编辑当时那条提问再发一次。
     *
     * <p>{@code messageId} 指明改哪条历史提问，{@code input} 是新内容；该轮及其之后的历史会被作废。
     * 与 {@link #acceptCommand} 同形态：同步受理、异步执行、不建流。</p>
     */
    @Operation(summary = "编辑历史提问后重发（同步受理）")
    @PostMapping(value = "/completion/resend", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<ChatAcceptanceVO> resend(@ModelAttribute ChatRequest chatRequest) {
        return chatService.resend(command(chatRequest));
    }

    /**
     * 订阅会话事件流：前端切回某个会话时用它重新挂载。
     *
     * <p>只投递挂上之后的事件。切走期间的缺口由前端回查会话历史对齐 ——
     * 服务端不做回放，实时通道与历史接口各管一段，不重复承担一致性。</p>
     */
    @Operation(summary = "订阅会话事件流（切回会话时重新挂载）")
    @GetMapping(value = "/completion/{sessionId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter subscribe(@PathVariable Long sessionId) {
        return chatService.subscribeSession(sessionId);
    }

    @Operation(summary = "停止当前会话及其全部子会话")
    @PostMapping("/completion/{sessionId}/stop")
    public void stop(@PathVariable Long sessionId) {
        chatService.stop(sessionId);
    }

    @Operation(summary = "暂停当前会话")
    @PostMapping("/completion/{sessionId}/suspend")
    public void suspend(@PathVariable Long sessionId) {
        chatService.suspend(sessionId);
    }

    /**
     * 手工压缩会话上下文（输入栏 {@code /compact}）：压完回执最新用量与新审计结果。
     *
     * <p>{@code body} 只是为了把「用户带着正文发了这条命令」判成拒绝：命令本身没有参数，
     * 带上正文说明他期待的是「按这段要求压缩」，而本能力不支持，静默丢弃就是吞字。
     * 前端也做同样校验，两边口径一致 —— 只在前端拦，绕过界面就没人管了。</p>
     */
    @Operation(summary = "手工压缩会话上下文并重算用量审计")
    @PostMapping("/completion/{sessionId}/compact")
    public Result<ContextCompactionVO> compactContext(@PathVariable long sessionId,
                                                      @RequestParam(required = false) String body) {
        return Result.success(contextCompactionService.compact(sessionId, body));
    }

    @Operation(summary = "恢复当前会话最近暂停的执行")
    @PostMapping("/completion/{sessionId}/resume")
    public Result<String> resume(@PathVariable Long sessionId,
                                 @RequestBody(required = false) ResumeSupplementCommand supplement) {
        return supplement == null ? chatService.resume(sessionId)
                : Result.success(resumeSupplementService.accept(sessionId, supplement));
    }

    /** 请求 → 命令：计划能力是否下发由请求显式声明，后端不再按会话状态推断。团队按会话绑定取值。 */
    private static ChatCommand command(ChatRequest request) {
        return new ChatCommand(request.input(), request.sessionId(),
                request.modelId(),
                request.workspaceId(),
                request.messageId(),
                request.agentId(),
                Objects.requireNonNullElse(request.requirePlan(), false),
                request.image(), request.imageUrl()
        );
    }
}
