package com.summit.dp.shared.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;

/**
 * MVC 配置：只负责消息转换器的 ObjectMapper 对齐。
 *
 * <p>本地单实例（HC-1）无登录身份，不存在身份拦截器；若后续引入需要
 * 请求预处理的能力，在独立配置类中扩展，不把职责混回这里。</p>
 */
@Component
public class WebConfigure implements WebMvcConfigurer {
    private final ObjectMapper objectMapper;

    public WebConfigure(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        for (HttpMessageConverter<?> converter : converters) {
            if (converter instanceof MappingJackson2HttpMessageConverter jacksonConverter) {
                jacksonConverter.setObjectMapper(objectMapper);
            }
        }
    }
}
