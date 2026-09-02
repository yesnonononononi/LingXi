package com.summit.dp.shared.vo;

import lombok.Builder;
import lombok.Data;

/**
 * 工作空间视图对象。
 */
@Data
@Builder
public class WorkspaceVO {
    private Long id;
    private String name;
    /** docker/local */
    private String type;
    /** docker 为容器内绝对路径；local 为主机目录 */
    private String workDir;
    /** 仅 docker 类型非空 */
    private String containerId;
}
