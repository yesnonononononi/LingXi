package com.summit.dp.workflow.infrastructure.config;

import dev.langchain4j.http.client.HttpClientBuilderFactory;
import dev.langchain4j.http.client.okhttp.OkHttpClient;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 模型调用统一选择 OkHttp，每个模型独立构建以隔离超时配置。 */
@Configuration(proxyBeanMethods = false)
public class ModelHttpClientConfiguration {
    @Bean
    public HttpClientBuilderFactory modelHttpClientBuilderFactory() {
        return OkHttpClient::builder;
    }
}
