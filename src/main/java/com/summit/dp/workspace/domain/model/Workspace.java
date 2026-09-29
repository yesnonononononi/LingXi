package com.summit.dp.workspace.domain.model;

import lombok.AllArgsConstructor;
import lombok.Getter;

/**
 * 工作空间领域实体：只登记期望状态（名称、宿主目录），不可变，换目录需重新登记。
 *
 * <p><b>为什么没有 type：</b>sandbox / local 决定的是「这个目录怎么被执行」，
 * 而不是「工作空间是什么」。该判定的唯一来源是用户通用配置
 * {@code user_configs.workspace_type}，随用户切换运行模式而变。
 * 把它复制一份落到 workspace 行上会产生第二份事实来源，两者不一致时无从裁决；
 * 因此这里只在需要构建运行时规格时才去读取用户配置。</p>
 */
@Getter
@AllArgsConstructor
public class Workspace {
    private Long id;
    private String name;
    /** 项目宿主机/本地绝对路径; sandbox类型作为容器挂载源, local类型直接作为运行工作目录 */
    private String hostDir;

    /** 由仓储回填自增主键；仅在新增持久化后立即调用一次。 */
    public void assignId(Long id) {
        this.id = id;
    }
}
