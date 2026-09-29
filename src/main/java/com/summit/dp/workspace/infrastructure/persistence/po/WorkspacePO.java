package com.summit.dp.workspace.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 工作空间持久化对象，与领域实体 {@code Workspace} 对齐。
 *
 * <p>不含类型字段：sandbox / local 只影响「怎么跑」，不影响「工作空间是什么」。
 * 该判定统一由用户的 {@code user_configs.workspace_type} 给出，落库会引入
 * 第二份事实来源，一旦与用户配置不一致就无从判断该信哪个。</p>
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("workspace")
public class WorkspacePO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    /** 项目宿主机/本地绝对路径; sandbox类型作为容器挂载源, local类型直接作为运行工作目录 */
    private String hostDir;
    private Instant createTime;
    private Instant updateTime;
}
