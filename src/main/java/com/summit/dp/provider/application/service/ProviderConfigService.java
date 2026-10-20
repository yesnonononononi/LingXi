package com.summit.dp.provider.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.provider.application.command.ProviderConfigCommand;
import com.summit.dp.provider.application.vo.ProviderConfigVO;

import java.util.List;
import java.util.Optional;

/** 提供商配置预设：区分多个来源的同名模型，模型配置与下拉分组都以它为依据。 */
public interface ProviderConfigService {

    Result<Void> add(ProviderConfigCommand command);

    Result<Void> update(ProviderConfigCommand command);

    /**
     * 删除预设只删预设本身：模型的 {@code provider_config_id} 保留为悬空引用，
     * 聚合查询查不到归属时自然归入「未分组」，不做级联清理。
     */
    Result<Void> del(Long id);

    Result<List<ProviderConfigVO>> listAll();

    Result<ProviderConfigVO> findById(Long id);

    /**
     * 跨模块只读入口：模型配置聚合直接消费，不经 {@link Result} 包装。
     *
     * @return 按 sortOrder、名称排序的全量预设（密钥已掩码）
     */
    List<ProviderConfigVO> findAllViews();

    /**
     * 跨模块只读入口：取提供商预设的<b>明文</b>密钥，供「模型复用提供方密钥」时复制落库。
     *
     * <p>只允许服务端内部调用，不得直接映射到任何接口响应。</p>
     *
     * @return 预设不存在或未配置密钥时为空
     */
    Optional<String> findApiKey(Long id);
}
