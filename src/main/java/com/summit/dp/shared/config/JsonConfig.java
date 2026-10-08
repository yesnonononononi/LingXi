package com.summit.dp.shared.config;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.jsontype.NamedType;
import com.summit.core.json.ExecutionJson;
import com.summit.dp.workspace.application.convert.LingXiWorkspaceSpec;
import com.summit.sandbox.docker.DockerWorkspaceSpec;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;

import java.math.BigInteger;

@Configuration
public class JsonConfig {

    @Bean
    @Primary
    public ObjectMapper objectMapper() {
        SimpleModule simpleModule = new SimpleModule();
        simpleModule.addSerializer(Long.class, ToStringSerializer.instance);
        simpleModule.addSerializer(Long.TYPE, ToStringSerializer.instance);
        simpleModule.addSerializer(BigInteger.class, ToStringSerializer.instance);

        ObjectMapper objectMapper = ExecutionJson.newObjectMapper(
                new NamedType(LingXiWorkspaceSpec.class, "local"),
                new NamedType(DockerWorkspaceSpec.class, "docker"));
        // 多态反序列化的失败边界必须显式：未知子类型要**明确失败**，不得静默转成某个默认子类型。
        // 该开关本就默认开启；显式声明是把它钉成不变量 —— 一旦有人引入 defaultImpl 或关掉它，
        // 契约里「未知类型失败」的承诺就会悄悄失效。
        objectMapper.enable(DeserializationFeature.FAIL_ON_INVALID_SUBTYPE);
        objectMapper.registerModule(simpleModule);
        return objectMapper;
    }

    @Bean
    public Jackson2ObjectMapperBuilderCustomizer jackson2ObjectMapperBuilderCustomizer() {
        return builder -> {
            builder.serializerByType(Long.class, ToStringSerializer.instance);
            builder.serializerByType(Long.TYPE, ToStringSerializer.instance);
            builder.serializerByType(BigInteger.class, ToStringSerializer.instance);
        };
    }
}
