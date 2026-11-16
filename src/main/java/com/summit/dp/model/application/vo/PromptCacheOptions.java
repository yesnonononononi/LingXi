package com.summit.dp.model.application.vo;

/**
 * 提示前缀缓存开关。
 *
 * <p>框架只在请求级配置带 {@code anthropicOptions} 时才给 system 与工具定义打 {@code cache_control}，
 * 而真实对话一律用请求级配置，所以这三项必须随模型连接一起下发，否则 yaml 里的开关等于没配。</p>
 */
public record PromptCacheOptions(boolean enabled, String ttl, boolean conversation) {
}
