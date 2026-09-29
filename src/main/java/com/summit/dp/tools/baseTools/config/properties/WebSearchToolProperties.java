package com.summit.dp.tools.baseTools.config.properties;


import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * web_search 的连接与结果参数。
 *
 * <p>没有 {@code enabled} 开关：工具是否装配由代码决定。要停用 web_search，从 Agent 的工具清单里
 * 去掉它即可（框架侧名单即授权），不必让「这个工具为什么没生效」变成一个查配置的问题。</p>
 */
@Data
@ConfigurationProperties(prefix = "lingxi.agent.runtime.tool.web-search")
public class WebSearchToolProperties {
    private String baseUrl ;
    private String apiKey;
    private int maxResult = 3;

}
