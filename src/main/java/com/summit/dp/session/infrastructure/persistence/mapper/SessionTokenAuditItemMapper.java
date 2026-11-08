package com.summit.dp.session.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionTokenAuditItemPO;
import org.apache.ibatis.annotations.Mapper;

/** 审计明细表：按 session_id 整批删/插，无自定义 SQL。 */
@Mapper
public interface SessionTokenAuditItemMapper extends BaseMapper<SessionTokenAuditItemPO> {
}
