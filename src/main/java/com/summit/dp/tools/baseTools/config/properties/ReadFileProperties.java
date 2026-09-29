package com.summit.dp.tools.baseTools.config.properties;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

@Data
@ConfigurationProperties(prefix = "lingxi.agent.runtime.tool.read-file")
public class ReadFileProperties {
    private boolean enabled;
}
