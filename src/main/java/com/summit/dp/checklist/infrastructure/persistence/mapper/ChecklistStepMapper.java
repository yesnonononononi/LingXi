package com.summit.dp.checklist.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.checklist.infrastructure.persistence.po.ChecklistStepPO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 清单步骤 Mapper。
 *
 * <p>这里只用 MyBatis-Plus 的条件查询与主键写；步骤永远通过父清单聚合访问，
 * 不存在「跳过父行锁单改步骤」的入口。</p>
 */
@Mapper
public interface ChecklistStepMapper extends BaseMapper<ChecklistStepPO> {
}
