package com.summit.dp.email.application.service.impl;

import cn.hutool.core.util.IdUtil;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.email.application.command.EmailMessageCommand;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.application.vo.EmailVO;
import com.summit.dp.email.domain.model.Email;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.email.domain.repository.EmailMessageRepository;
import com.summit.dp.email.domain.repository.EmailRepository;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Objects;
import java.util.HashSet;
import java.util.Set;
import java.util.ArrayList;
import java.util.Optional;

/**
 * Email 应用层服务实现。
 *
 * <p>写路径的 id 统一由应用层雪花生成（项目惯例）；读路径 findById 装载消息、
 * 分页/批量不装载（避免 N+1）；删除为事务内级联。
 * 校验失败与业务冲突一律抛 {@code ClientException}，由全局异常处理器统一返回错误；
 * 消费路径以条件更新消除 check-then-act 竞态。</p>
 *
 * <p>路由语义：邮箱业务键是 {@code (workflowExecutionId, recipientAgentId)}。
 * 投递走「获取或创建」，并发首次建箱由 {@code uk_email_workflow_recipient} 唯一索引裁决；
 * 消费走精确等值查询，不再使用两个执行 ID 的 {@code OR}。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class EmailServiceImpl implements EmailService {

    private final EmailRepository repository;
    private final EmailMessageRepository messageRepository;

    @Override
    public Result<EmailVO> findById(Long id) {
        if (id == null) {
            throw new ClientException("id is null");
        }
        // 单查装载聚合内消息；分页/批量不装载（见 findPage/queryIn），避免 N+1。
        Email model = repository.findById(id).orElseThrow(ClientException::new);
        List<EmailMessage> messages = messageRepository.findByEmailId(id);
        return Result.success(toVO(model, messages));
    }

    @Override
    public Result<PageResult<EmailVO>> findPage(Integer page, Integer pageSize,
                                                Long recipientAgentId, Long teamId) {
        int current = page == null ? 1 : Math.max(page, 1);
        int size = pageSize == null ? 10 : Math.max(pageSize, 1);
        IPage<Email> pageResult = repository.queryByPage(current, size, recipientAgentId, teamId);
        PageResult<EmailVO> result = new PageResult<>(pageResult.getCurrent(), pageResult.getSize(),
                pageResult.getTotal(), pageResult.getRecords().stream().map(this::toVO).toList());
        return Result.success(result);
    }

    @Override
    @Transactional
    public Result<Void> delById(Long id) {
        if (id == null) {
            throw new ClientException("id is null");
        }
        Email model = repository.findById(id).orElseThrow(ClientException::new);
        // 级联：先删该邮箱全部消息，再删邮箱本身（同一事务）。
        messageRepository.deleteByEmailId(id);
        repository.delete(model);
        return Result.success();
    }

    @Override
    public Result<List<EmailVO>> queryIn(Collection<Long> ids) {
        // null/空集合是合法查询结果，返回空列表而非校验失败；不存在的 id 仍静默过滤。
        if (ids == null || ids.isEmpty()) {
            return Result.success(List.of());
        }
        return Result.success(repository.findList(ids).stream().map(this::toVO).toList());
    }

    @Override
    @Transactional
    public Result<EmailMessageVO> sendMail(Long toAgentId, String content, MailSendContext context) {
        validateMail(toAgentId, content, context);
        Long workflowExecutionId = context.workflowExecutionId();
        Long senderAgentId = context.senderAgentId();

        // 1) 获取或创建收件 Agent 的角色邮箱（业务键 = 协作根会话 + 收件 Agent）
        Email mailbox = obtainMailbox(workflowExecutionId, toAgentId, context.teamId());

        // 2) 同一事务内写入一条 PENDING 消息
        EmailMessage message = EmailMessage.builder()
                .id(IdUtil.getSnowflakeNextId())
                .emailId(mailbox.getId())
                .senderId(senderAgentId)
                .content(content)
                .status(EmailMessage.EMStatus.PENDING)
                .createAt(Instant.now())
                .build();
        messageRepository.save(message);
        return Result.success(toMessageVO(message));
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Result<EmailMessageVO> sendMailOnce(Long toAgentId, String content, MailSendContext context,
                                              String dedupKey) {
        validateMail(toAgentId, content, context);
        throwIf(dedupKey == null || dedupKey.isBlank(), "通知去重键不能为空");
        throwIf(dedupKey.length() > EmailMessage.MAX_DEDUP_KEY_LENGTH, "通知去重键不能超过160个字符");
        Email mailbox = obtainMailbox(context.workflowExecutionId(), toAgentId, context.teamId());
        EmailMessage message = EmailMessage.builder()
                .id(IdUtil.getSnowflakeNextId()).emailId(mailbox.getId()).senderId(context.senderAgentId())
                .dedupKey(dedupKey).content(content).status(EmailMessage.EMStatus.PENDING)
                .createAt(Instant.now()).build();

        // 提交后回调需要独立事务；去重键与消息一起插入，失败回滚不会提前占用去重键。
        try {
            messageRepository.save(message);
            return Result.success(toMessageVO(message));
        } catch (DuplicateKeyException error) {
            EmailMessage existing = messageRepository.findByDedupKeyForUpdate(dedupKey).orElseThrow(() -> error);
            throwIf(!mailbox.getId().equals(existing.getEmailId())
                    || !context.senderAgentId().equals(existing.getSenderId()), "通知去重键已用于其他收发对象");
            return Result.success(toMessageVO(existing));
        }
    }

    private void validateMail(Long toAgentId, String content, MailSendContext context) {
        throwIf(context == null, "发信上下文不能为空");
        throwIf(toAgentId == null, "收件成员不能为空");
        throwIf(content == null || content.isBlank(), "邮件内容不能为空");
        throwIf(context.workflowExecutionId() == null, "协作根会话不能为空");
        throwIf(context.senderAgentId() == null, "发件成员不能为空");
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    @Override
    @Transactional
    public Result<List<EmailMessageVO>> consumePending(Long workflowExecutionId, Long recipientAgentId) {
        throwIf(workflowExecutionId == null || recipientAgentId == null, "收件箱归属不能为空");
        List<EmailMessageVO> items = pendingItems(workflowExecutionId, recipientAgentId);
        consumePendingItems(items);
        return Result.success(items);
    }

    @Override
    public List<EmailMessageVO> pendingItems(Long workflowExecutionId, Long recipientAgentId) {
        if (workflowExecutionId == null || recipientAgentId == null) return List.of();
        Optional<Email> mailbox = repository.findByBusinessKey(workflowExecutionId, recipientAgentId);
        if (mailbox.isEmpty()) return List.of();
        return messageRepository.findPendingByEmailIds(List.of(mailbox.get().getId()))
                .stream().map(this::toMessageVO).toList();
    }

    @Override
    @Transactional
    public void consumePendingItems(List<EmailMessageVO> items) {
        throwIf(items == null, "待消费消息列表不能为空");
        if (items.isEmpty()) return;
        List<EmailMessage> pending = new ArrayList<>();
        Set<Long> ids = new HashSet<>();
        for (EmailMessageVO item : items) {
            throwIf(item == null || item.getId() == null || !ids.add(item.getId()), "待消费消息标识缺失或重复");
            EmailMessage message = messageRepository.findById(item.getId()).orElseThrow(ClientException::new);
            throwIf(!message.isPending() || !Objects.equals(message.getEmailId(), item.getEmailId())
                    || !Objects.equals(message.getContent(), item.getContent()), "待消费消息已发生变化，请重新读取");
            message.consume();
            pending.add(message);
        }
        int affected;
        try {
            affected = messageRepository.consumePendingByIds(pending);
        } catch (CannotAcquireLockException conflict) {
            throw new ClientException("收件箱正在被并发消费，请重试", conflict);
        }
        throwIf(affected != pending.size(), "部分消息状态已变化，请重新读取本批消息");
    }

    /**
     * 获取或创建角色邮箱。
     *
     * <p>业务键 {@code (workflowExecutionId, recipientAgentId)} 上有唯一索引，因此并发首次建箱
     * 只有一个 INSERT 成功，其余落到 {@link DuplicateKeyException}，回查即得已存在邮箱。</p>
     *
     * <p><b>顺序是刻意的：先插入，再回查，绝不先读一遍再插入。</b>SQLite 只有一个写者，
     * 事务里「先读后升写」在竞争时不会排队等锁（升写失败会立刻返回 SQLITE_BUSY，
     * busy_timeout 对升写不生效），所以这里让事务的第一条语句就是写：
     * 抢不到锁时由 busy_timeout 正常等待，抢到了则由唯一索引裁决并发。</p>
     *
     * <p>冲突后的回查不需要（也不存在）行锁：能走到 {@code DuplicateKeyException}，说明本次写
     * 已经看到过竞争方提交后的最新快照，紧接着的读取一定能读到那一行。</p>
     *
     * @return 已存在或刚创建的邮箱（保证带 id）
     */
    private Email obtainMailbox(Long workflowExecutionId, Long recipientAgentId, Long teamId) {
        Email created = Email.builder()
                .id(IdUtil.getSnowflakeNextId())
                .workflowExecutionId(workflowExecutionId)
                .recipientAgentId(recipientAgentId)
                .teamId(teamId)
                .status(Email.STATUS_ACTIVE)
                .build();
        try {
            repository.save(created);
            return created;
        } catch (DuplicateKeyException e) {
            log.debug("邮箱并发首次创建，回查已存在邮箱: workflowExecutionId={}, recipientAgentId={}",
                    workflowExecutionId, recipientAgentId);
            return repository.findByBusinessKey(workflowExecutionId, recipientAgentId)
                    .orElseThrow(() -> new ClientException("邮箱并发创建后回查失败"));
        }
    }

    @Override
    public boolean hasPending(Long workflowExecutionId, Long recipientAgentId) {
        return !pendingItems(workflowExecutionId, recipientAgentId).isEmpty();
    }

    @Override
    public Result<EmailMessageVO> addMessage(EmailMessageCommand command) {
        if (command == null || command.getEmailId() == null) {
            throw new ClientException("emailId is null");
        }
        if (command.getContent() == null || command.getContent().isBlank()) {
            throw new ClientException("content is null");
        }
        // 校验邮箱存在，避免悬挂消息。
        repository.findById(command.getEmailId())
                .orElseThrow(() -> new ClientException("emailId 对应数据不存在"));
        EmailMessage message = EmailMessage.builder()
                .id(IdUtil.getSnowflakeNextId())
                .emailId(command.getEmailId())
                .senderId(command.getSenderId())
                .content(command.getContent())
                .status(EmailMessage.EMStatus.PENDING)
                .createAt(Instant.now())
                .build();
        messageRepository.save(message);
        return Result.success(toMessageVO(message));
    }

    @Override
    public Result<List<EmailMessageVO>> listMessages(Long emailId) {
        if (emailId == null) {
            throw new ClientException("emailId is null");
        }
        return Result.success(messageRepository.findByEmailId(emailId).stream()
                .map(this::toMessageVO).toList());
    }

    @Override
    public Result<EmailMessageVO> updateMessageContent(Long id, String content) {
        if (id == null) {
            throw new ClientException("id is null");
        }
        if (content == null || content.isBlank()) {
            throw new ClientException("content is null");
        }
        EmailMessage message = messageRepository.findById(id).orElseThrow(ClientException::new);
        message.updateContent(content);
        messageRepository.updateById(message);
        return Result.success(toMessageVO(message));
    }

    @Override
    public Result<EmailMessageVO> consumeMessage(Long id) {
        if (id == null) {
            throw new ClientException("id is null");
        }
        // 先区分「不存在」；消费以条件更新落库，消除 check-then-act 竞态窗口。
        EmailMessage message = messageRepository.findById(id).orElseThrow(ClientException::new);
        int affected = messageRepository.consumePendingById(id);
        if (affected == 0) {
            throw new ClientException("该消息已消费");
        }
        message.consume();
        return Result.success(toMessageVO(message));
    }

    /** 聚合根 → VO；messages 非 null 时装载 messageVOList，null 时保持未装载（语义区分）。 */
    private EmailVO toVO(Email model, List<EmailMessage> messages) {
        EmailVO vo = EmailVO.builder()
                .id(model.getId())
                .workflowExecutionId(model.getWorkflowExecutionId())
                .recipientAgentId(model.getRecipientAgentId())
                .teamId(model.getTeamId())
                .status(model.getStatus())
                .createAt(model.getCreateAt())
                .updateAt(model.getUpdateAt())
                .build();
        if (messages != null) {
            vo.setMessageVOList(messages.stream().map(this::toMessageVO).toList());
        }
        return vo;
    }

    /** 分页/批量路径：不装载消息。 */
    private EmailVO toVO(Email model) {
        return toVO(model, null);
    }

    private EmailMessageVO toMessageVO(EmailMessage message) {
        return EmailMessageVO.builder()
                .id(message.getId())
                .emailId(message.getEmailId())
                .senderId(message.getSenderId())
                .content(message.getContent())
                .status(message.getStatus())
                .createAt(message.getCreateAt())
                .updateAt(message.getUpdateAt())
                .build();
    }
}
