package com.summit.dp.shared.vo;

import lombok.Builder;

/**
 * 工作空间视图对象。
 *
 * <p>不含 type / port / image：这三项描述的是「怎么跑」而非「工作空间是什么」，
 * 运行类型统一由实例设置的 {@code user_configs.workspace_type} 决定，见
 * {@code WorkspaceConverter#resolveType}。本地单实例（HC-1）无归属字段。</p>
 */
@Builder
public record WorkspaceVO(
        Long id,
        String name,

        String workDir,

        String hostDir
) {

}
