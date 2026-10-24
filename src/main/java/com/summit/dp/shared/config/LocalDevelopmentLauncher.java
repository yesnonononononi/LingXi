package com.summit.dp.shared.config;

import org.springframework.boot.SpringApplication;

import java.io.File;

/** 源码运行单独启用本地配置，避免安装包沿用相同的 dev 档位而访问开发数据。 */
public final class LocalDevelopmentLauncher {
    private LocalDevelopmentLauncher() {
    }

    public static void configure(SpringApplication application, File source) {
        if (source != null && source.isDirectory()) {
            application.setAdditionalProfiles("dev", "local");
        }
    }
}
