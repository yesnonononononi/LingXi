package com.summit.dp.email.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

/**
 * Email MyBatis Mapper（生成骨架）
 */
@Mapper
public interface EmailMapper extends BaseMapper<EmailPO> {

    /**
     * 取「尚有未消费消息」的邮箱所属会话 id 集合（去重）。
     *
     * <p>邮箱业务键的一半就是会话 id（{@code workflow_execution_id}），因此这里返回的正是启动自检
     * 需要的候选会话，不必把邮箱或消息整行读进内存。待消费状态由 {@link Param} 传入，
     * 无外部输入拼接。</p>
     *
     * @param pendingStatus {@code email_message.status} 的待消费编码
     * @return 去重后的会话 id，无候选返回空列表
     */
    @Select("SELECT DISTINCT e.workflow_execution_id FROM email e"
            + " WHERE EXISTS (SELECT 1 FROM email_message m"
            + " WHERE m.email_id = e.id AND m.status = #{pendingStatus})")
    List<Long> selectPendingMailboxSessionIds(@Param("pendingStatus") String pendingStatus);
}
