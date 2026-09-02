package com.summit.dp.workspace.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Builder;
import lombok.Data;

/**
 * 工作空间持久化对象，与领域实体 {@code Workspace} 对齐（type 以小写字符串落库）。
 */
@Data
@Builder
@TableName("workspace")
public class WorkspacePO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    /** docker/local */
    private String type;
    /** docker 为容器内绝对路径；local 为主机目录 */
    private String workDir;
    /** 仅 docker 类型非空 */
    private String containerId;
}
