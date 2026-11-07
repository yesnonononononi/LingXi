package com.summit.dp.session.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionTokenAuditPO;
import org.apache.ibatis.annotations.Mapper;

/** 审计快照头表：只按会话 id 读写，无自定义 SQL（upsert 在仓储实现里用 Wrapper 表达）。 */
@Mapper
public interface SessionTokenAuditMapper extends BaseMapper<SessionTokenAuditPO> {
}
