package com.summit.dp.tools.baseTools.config.properties;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

@Data
@ConfigurationProperties(prefix = "lingxi.agent.runtime.tool.terminal")
public class TerminalToolProperties {
    private boolean enabled;
}
