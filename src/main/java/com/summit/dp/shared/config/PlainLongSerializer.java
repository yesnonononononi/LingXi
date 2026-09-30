package com.summit.dp.shared.config;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.SerializerProvider;

import java.io.IOException;

/**
 * 把 {@code Long} 序列化为 JSON **数字**，用于覆盖全局的「Long → String」策略。
 *
 * <p><b>为什么需要它：</b>{@link JsonConfig} 为防雪花 ID 在前端丢精度，把
 * {@code Long}/{@code long} 全局注册成 {@code ToStringSerializer}。这对手持 ID 是对的，
 * 但对**统计量**（token 数、毫秒数）是错的：前端要拿它们做加减与格式化，
 * 拿到字符串就得处处 {@code Number()}，还容易把 {@code "0"} 当真值参与比较。</p>
 *
 * <p>字段级 {@code @JsonSerialize(using = ...)} 的优先级高于模块级类型序列化器，
 * 因此只影响显式标注的字段，全局约定不变。</p>
 */
public class PlainLongSerializer extends JsonSerializer<Long> {

    @Override
    public void serialize(Long value, JsonGenerator gen, SerializerProvider serializers) throws IOException {
        if (value == null) {
            gen.writeNull();
            return;
        }
        gen.writeNumber(value);
    }
}
