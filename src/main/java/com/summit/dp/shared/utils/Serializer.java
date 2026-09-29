package com.summit.dp.shared.utils;

import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.jsontype.impl.LaissezFaireSubTypeValidator;
import org.springframework.stereotype.Component;

@Component
public class Serializer {
    private final ObjectMapper objectMapper;
    /**
     * 支持多态（接口/抽象类）的序列化与反序列化，用于持久化会话数据。
     */
    private final ObjectMapper polymorphicObjectMapper;

    public Serializer(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.polymorphicObjectMapper = objectMapper.copy();
        this.polymorphicObjectMapper.activateDefaultTyping(
                LaissezFaireSubTypeValidator.instance,
                ObjectMapper.DefaultTyping.NON_FINAL,
                JsonTypeInfo.As.PROPERTY);
    }

    public String serialize(Object o) throws JsonProcessingException {
        return objectMapper.writeValueAsString(o);
    }

    public <T> T deserialize(String s, Class<T> tClass) throws JsonProcessingException {
        return objectMapper.readValue(s, tClass);
    }

    public <T> T deserialize(String s, TypeReference<T> typeReference) throws JsonProcessingException {
        return objectMapper.readValue(s, typeReference);
    }

    public String serializePolymorphic(Object o) throws JsonProcessingException {
        return polymorphicObjectMapper.writeValueAsString(o);
    }

    public <T> T deserializePolymorphic(String s, TypeReference<T> typeReference) throws JsonProcessingException {
        return polymorphicObjectMapper.readValue(s, typeReference);
    }
}
