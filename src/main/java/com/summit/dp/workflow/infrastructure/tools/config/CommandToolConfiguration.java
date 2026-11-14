package com.summit.dp.workflow.infrastructure.tools.config;

import com.summit.dp.workflow.infrastructure.tools.config.properties.CommandToolProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/** 终端工具属性绑定入口：属性类只在这里交给容器，具体取值由执行器构造注入。 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(CommandToolProperties.class)
public class CommandToolConfiguration {
}
