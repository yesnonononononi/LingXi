package com.summit.dp.provider.domain.model;

import com.summit.dp.shared.exception.ClientException;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * 模型提供商配置预设。
 *
 * <p>同一模型名可能来自不同提供商，{@code model_config.provider_config_id} 指向本对象，
 * 用于在下拉与配置页区分来源；模型选择本身仍以 {@code model_id} 为准。</p>
 */
@AllArgsConstructor
@NoArgsConstructor
@Getter
public class ProviderConfig {

    public static final int NAME_MAX_LENGTH = 100;
    public static final int ICON_MAX_LENGTH = 200;
    public static final int BASE_URL_MAX_LENGTH = 500;

    private Long id;
    private String name;
    /** 内置图标 key、emoji 或图片 URL；为空时前端用名称首字兜底 */
    private String icon;
    /** 该提供商下模型的 Base URL 缺省值 */
    private String baseUrl;
    /** 提供商级 API 密钥缺省值 */
    private String apiKey;
    /** 展示排序，小的在前 */
    private Integer sortOrder;

    public void changeName(String name) {
        throwIf(name == null || name.isBlank(), "提供商名称不能为空");
        throwIf(name.trim().length() > NAME_MAX_LENGTH, "提供商名称不能超过 " + NAME_MAX_LENGTH + " 个字符");
        this.name = name.trim();
    }

    public void changeIcon(String icon) {
        throwIf(icon != null && icon.trim().length() > ICON_MAX_LENGTH,
                "提供商图标不能超过 " + ICON_MAX_LENGTH + " 个字符");
        this.icon = icon == null || icon.isBlank() ? null : icon.trim();
    }

    public void changeBaseUrl(String baseUrl) {
        throwIf(baseUrl != null && baseUrl.trim().length() > BASE_URL_MAX_LENGTH,
                "API Base URL 不能超过 " + BASE_URL_MAX_LENGTH + " 个字符");
        this.baseUrl = baseUrl == null || baseUrl.isBlank() ? null : baseUrl.trim();
    }

    public void changeApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    public void changeSortOrder(Integer sortOrder) {
        this.sortOrder = sortOrder == null ? 0 : sortOrder;
    }

    /** 接口固定返回前 20% + *** + 后 20%，与模型密钥同一掩码规则。 */
    public String getMaskedApiKey() {
        if (apiKey == null || apiKey.isEmpty()) return apiKey;
        int length = apiKey.codePointCount(0, apiKey.length());
        int visible = length / 5;
        int prefixEnd = apiKey.offsetByCodePoints(0, visible);
        int suffixStart = apiKey.offsetByCodePoints(0, length - visible);
        return apiKey.substring(0, prefixEnd) + "***" + apiKey.substring(suffixStart);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
