package com.summit.dp.email.infrastructure.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.email.domain.model.Email;
import com.summit.dp.email.domain.repository.EmailRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailPO;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * Email 仓储实现。
 * <p>过滤分页直接用 mapper.selectPage + LambdaQueryWrapper（列名经方法引用推导，不拼字符串）；
 * 业务键查询为精确等值条件，与 {@code uk_email_workflow_recipient} 唯一索引同形。</p>
 */
@Repository
public class EmailRepositoryImpl extends AbstractRepository<Email, EmailPO, Long>
        implements EmailRepository {

    private final EmailMapper mapper;

    public EmailRepositoryImpl(EmailMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    protected @NotNull BaseMapper<EmailPO> mapper() {
        return this.mapper;
    }

    @Override
    public Collection<Email> findList(Collection<Long> ids) {
        return super.findList(ids);
    }

    @Override
    public IPage<Email> queryByPage(int current, int size, Long recipientAgentId, Long teamId) {
        LambdaQueryWrapper<EmailPO> wrapper = Wrappers.<EmailPO>lambdaQuery();
        if (recipientAgentId != null) {
            wrapper.eq(EmailPO::getRecipientAgentId, recipientAgentId);
        }
        if (teamId != null) {
            wrapper.eq(EmailPO::getTeamId, teamId);
        }
        // 雪花主键趋势递增，按 id 倒序 = 新邮箱在前，且分页顺序确定
        wrapper.orderByDesc(EmailPO::getId);
        return mapper.selectPage(new Page<>(Math.max(current, 1), Math.max(size, 1)), wrapper)
                .convert(this::toModel);
    }

    @Override
    public Optional<Email> findByBusinessKey(Long workflowExecutionId, Long recipientAgentId) {
        if (workflowExecutionId == null || recipientAgentId == null) {
            return Optional.empty();
        }
        // 业务键上有唯一索引，最多命中一行；命中多行意味着数据未完成迁移，属真实数据完整性问题
        EmailPO po = mapper.selectOne(Wrappers.<EmailPO>lambdaQuery()
                .eq(EmailPO::getWorkflowExecutionId, workflowExecutionId)
                .eq(EmailPO::getRecipientAgentId, recipientAgentId));
        return po == null ? Optional.empty() : Optional.of(toModel(po));
    }

    @Override
    public Optional<Email> findByBusinessKeyForUpdate(Long workflowExecutionId, Long recipientAgentId) {
        if (workflowExecutionId == null || recipientAgentId == null) {
            return Optional.empty();
        }
        // 锁定读（当前读）：绕过本事务的 read view，读到竞争方刚提交的邮箱行。
        // 冲突回查时该行必定已存在，锁的是既有行而非间隙，不引入额外的间隙锁。
        EmailPO po = mapper.selectOne(Wrappers.<EmailPO>lambdaQuery()
                .eq(EmailPO::getWorkflowExecutionId, workflowExecutionId)
                .eq(EmailPO::getRecipientAgentId, recipientAgentId)
                .last("FOR UPDATE"));
        return po == null ? Optional.empty() : Optional.of(toModel(po));
    }

    @Override
    protected Email toModel(EmailPO po) {
        return Email.builder()
                .id(po.getId())
                .workflowExecutionId(po.getWorkflowExecutionId())
                .recipientAgentId(po.getRecipientAgentId())
                .teamId(po.getTeamId())
                .status(po.getStatus())
                .createAt(po.getCreateAt())
                .updateAt(po.getUpdateAt())
                .build();
    }

    @Override
    protected EmailPO toPO(Email model) {
        return EmailPO.builder()
                .id(model.getId())
                .workflowExecutionId(model.getWorkflowExecutionId())
                .recipientAgentId(model.getRecipientAgentId())
                .teamId(model.getTeamId())
                .status(model.getStatus())
                .createAt(model.getCreateAt())
                .updateAt(model.getUpdateAt())
                .build();
    }
}
