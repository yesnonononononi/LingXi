package com.summit.dp.shared.config;

import com.summit.dp.shared.config.interceptor.GlobalInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Component
public class WebConfigure implements WebMvcConfigurer {
    private final GlobalInterceptor globalInterceptor;

    public WebConfigure(GlobalInterceptor globalInterceptor) {
        this.globalInterceptor = globalInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(globalInterceptor)
                .excludePathPatterns(
                        "/error",
                        "/auth/login",
                        "/auth/register",
                        "/auth/sms",
                        "/auth/forget-pass",
                        "/swagger-ui.html",
                        "/swagger-ui/**",
                        "/v3/api-docs/**",
                        "/doc.html"
                );
        WebMvcConfigurer.super.addInterceptors(registry);
    }
}
