package com.summit.dp.email.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.application.vo.EmailVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Email 接口层：<b>只保留只读查询与受控的级联删除</b>。
 *
 * <p>邮箱的路由字段（{@code workflowExecutionId} / {@code recipientAgentId} / {@code teamId}）
 * 与消息的发件人身份都必须来自受控上下文，因此本层不再提供任何写入口：</p>
 * <ul>
 *   <li>原 {@code /email/add}、{@code /email/update} 已移除——不允许客户端任意指定或篡改投递路由。</li>
 *   <li>原 {@code /email/message/add} 已移除——它接受调用方自带的 {@code senderId}，会让调用方
 *       冒充任意 Agent 发信；而循环拦截器会把消息以「@发件人 给你发送了一个新需求」渲染进收件
 *       Agent 的模型上下文，等于开放了一条提示注入通道。</li>
 *   <li>原 {@code /email/message/consume-batch} 已移除——它接受任意的
 *       {@code (executionId, agentId)} 并把命中消息置为 CONSUMED，等于允许外部调用方
 *       <b>窃取或抽干</b>任意邮箱，使真正的收件 Agent 永远收不到消息。</li>
 * </ul>
 *
 * <p>投递与消费这两条写路径只在进程内被调用：投递走 {@code SendMailToAgentTool} →
 * {@code EmailService.sendMail}，消费走 {@code AgenticLoopInterceptor} →
 * {@code EmailService.consumePending}。若日后确实需要运维界面，应先引入本地鉴权，
 * 再以显式的管理端点重新开放。</p>
 */
@RestController
@RequestMapping("/email")
@RequiredArgsConstructor
public class EmailController {
    private final EmailService service;

    @GetMapping("/find/{id}")
    public Result<EmailVO> findById(@PathVariable Long id) {
        return service.findById(id);
    }

    @GetMapping("/message/list/{emailId}")
    public Result<List<EmailMessageVO>> listMessages(@PathVariable Long emailId) {
        return service.listMessages(emailId);
    }

    /**
     * 受控的级联删除：先删该邮箱全部消息，再删邮箱本身（同一事务）。
     *
     * <p>用 {@code DELETE} 而非 {@code GET}：破坏性操作走 GET 会被浏览器预加载、爬虫或链接预览
     * 误触发，从而静默删掉一整封邮箱及其消息。本端点没有任何 GET 调用方。</p>
     */
    @DeleteMapping("/del/{id}")
    public Result<Void> delById(@PathVariable Long id) {
        return service.delById(id);
    }
}
