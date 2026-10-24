package com.summit.dp.model;

import com.summit.dp.workflow.infrastructure.config.ModelHttpClientConfiguration;
import com.summit.harness.springbootautoconfigure.config.ModelProviderConfig;
import dev.langchain4j.http.client.HttpClientBuilder;
import dev.langchain4j.http.client.HttpClientBuilderFactory;
import dev.langchain4j.http.client.okhttp.OkHttpClientBuilder;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotSame;

/** 生产配置必须替换框架默认工厂，并隔离并发模型的可变配置。 */
class ModelHttpClientConfigurationTest {
    @Test
    void applicationSelectsOkHttpInsteadOfFrameworkDefaultAndIsolatesBuilders() {
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(ModelProviderConfig.class))
                .withUserConfiguration(ModelHttpClientConfiguration.class)
                .run(context -> {
                    assertEquals(1, context.getBeansOfType(HttpClientBuilderFactory.class).size());
                    HttpClientBuilderFactory factory = context.getBean(HttpClientBuilderFactory.class);
                    HttpClientBuilder first = factory.create();
                    HttpClientBuilder second = factory.create();
                    assertInstanceOf(OkHttpClientBuilder.class, first);
                    assertInstanceOf(OkHttpClientBuilder.class, second);
                    assertNotSame(first, second);
                    first.connectTimeout(Duration.ofSeconds(2)).readTimeout(Duration.ofSeconds(60));
                    second.connectTimeout(Duration.ofSeconds(5)).readTimeout(Duration.ofSeconds(120));
                    assertEquals(Duration.ofSeconds(2), first.connectTimeout());
                    assertEquals(Duration.ofSeconds(60), first.readTimeout());
                    assertEquals(Duration.ofSeconds(5), second.connectTimeout());
                    assertEquals(Duration.ofSeconds(120), second.readTimeout());
                });
    }
}
