package com.summit.dp.email.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.email.application.command.EmailMessageCommand;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.application.vo.EmailVO;

import java.util.Collection;
import java.util.List;

/**
 * Email 应用层服务。
 *
 * <p>邮箱是「一次协作轮次里、一个收件 Agent 的角色邮箱」，业务键为
 * {@code (workflowExecutionId, recipientAgentId)}。对外意图收敛为两个动作：
 * {@link #sendMail(Long, String, MailSendContext)}（按角色投递，邮箱不存在则创建）与
 * {@link #consumePending(Long, Long)}（按业务键精确消费）。</p>
 *
 * <p>校验失败与业务冲突一律抛 {@code ClientException}，由全局异常处理器统一返回错误；
 * 成功路径返回 {@code Result.success}。</p>
 */
public interface EmailService {

    /**
     * 按 id 查邮箱（装载聚合内全部消息）；id 为空或不存在抛 ClientException。
     */
    Result<EmailVO> findById(Long id);

    /**
     * 分页查询邮箱（不装载消息，避免 N+1），支持按收件 Agent / 团队快照过滤。
     */
    Result<PageResult<EmailVO>> findPage(Integer page, Integer pageSize, Long recipientAgentId, Long teamId);

    /**
     * 删除邮箱：事务内先级联删除该邮箱全部消息，再删除邮箱本身；id 为空或不存在抛 ClientException。
     */
    Result<Void> delById(Long id);

    /**
     * 按标识集合批量查询（不装载消息）；null/空集合返回空列表（空是合法查询结果）。
     */
    Result<List<EmailVO>> queryIn(Collection<Long> ids);

    /**
     * 投递一封邮件给指定 Agent 角色。
     *
     * <p>以 {@code (context.workflowExecutionId(), toAgentId)} 获取或创建邮箱，随后在同一事务内
     * 写入一条 {@code PENDING} 消息。发信目标是 Agent 角色，不要求目标执行已创建；
     * 并发首次建箱由唯一索引裁决，失败方回查已存在邮箱。</p>
     *
     * @param toAgentId 收件 Agent ID（必填）
     * @param content   邮件正文（必填、非空白）
     * @param context   受控发信上下文（协作根会话、发送者、团队快照）
     * @return 新写入的消息
     */
    Result<EmailMessageVO> sendMail(Long toAgentId, String content, MailSendContext context);

    /**
     * 按业务键精确消费待处理消息：{@code workflow_execution_id = ? AND recipient_agent_id = ?}。
     *
     * <p>邮箱不存在或无 PENDING 消息时返回空列表（空是合法结果）。事务内以条件更新
     * （仅 PENDING 可置 CONSUMED）消除 check-then-act 竞态，并核对生效行数；
     * 并发窗口内有消息被抢先消费时整体回滚并抛 ClientException，重试只取仍 PENDING 的消息。</p>
     *
     * @param workflowExecutionId 协作根会话 ID（邮箱业务键的一半；列名保持历史命名）
     * @param recipientAgentId    收件 Agent ID
     * @return 本次成功消费的消息（按 createAt, id 升序）
     */
    Result<List<EmailMessageVO>> consumePending(Long workflowExecutionId, Long recipientAgentId);

    /**
     * 是否还有未处理的协作输入（只读，<b>不消费</b>）。
     *
     * <p>供「根代理收尾前驻留」判定使用：收尾判定只允许读、不允许消费，消费只发生在
     * {@code AgenticLoopInterceptor.onBeforeModelInvoke}（新一轮模型调用前）。两者合并会让邮件
     * 在还没进入模型上下文前就被判定掉。</p>
     *
     * @param workflowExecutionId 协作根会话 ID（邮箱业务键的一半）
     * @param recipientAgentId    收件 Agent ID
     * @return 存在 PENDING 消息返回 {@code true}；邮箱不存在 / 参数缺失返回 {@code false}
     */
    boolean hasPending(Long workflowExecutionId, Long recipientAgentId);

    /**
     * 低层受控操作：向已存在的邮箱追加一条 PENDING 消息（校验邮箱存在，避免悬挂消息）。
     */
    Result<EmailMessageVO> addMessage(EmailMessageCommand command);

    /**
     * 查询某个邮箱的全部消息，按 createAt, id 升序。
     */
    Result<List<EmailMessageVO>> listMessages(Long emailId);

    /**
     * 修订消息内容（走领域 updateContent，维护 updateAt）。
     */
    Result<EmailMessageVO> updateMessageContent(Long id, String content);

    /**
     * 消费单条消息：条件更新仅 PENDING 可消费；不存在或已 CONSUMED 抛 ClientException（「该消息已消费」）。
     */
    Result<EmailMessageVO> consumeMessage(Long id);
}
