package com.summit.dp.shared.utils;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.ddd.infrastructure.repository.yaml.AtomicFileWriter;
import com.summit.ddd.infrastructure.repository.yaml.YamlListCodec;
import java.util.List;

import lombok.NonNull;
import lombok.extern.slf4j.Slf4j;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;

import java.io.File;
import java.io.IOException;
import java.nio.file.Path;

@Slf4j
@Component
public class YamlSerializer {
    private final ObjectMapper yamlMapper;

    public YamlSerializer(@Qualifier("yamlMapper") ObjectMapper yamlMapper) {
        this.yamlMapper = yamlMapper;
    }

    public <T> T deserialize(@NonNull Path path, @NonNull Class<T> clazz) {
        return deserialize(path, null, clazz);
    }
    public <T> T deserialize(@NonNull Path path, @NonNull TypeReference<T> type) {
       return deserialize(path, type, null);
    }
    public <T> T deserialize(@NonNull Path path,  TypeReference<T> type,  Class<T> clazz) {
        File file = path.toFile();
        if(!file.exists()) return null;
        if(type == null && clazz == null) throw new IllegalArgumentException("必须指定 YAML 配置类型");
        try {
            return type == null ? yamlMapper.readValue(file, clazz) : yamlMapper.readValue(file, type);
        } catch (IOException e) {
            throw new IllegalStateException("读取 YAML 配置失败: " + file.getAbsolutePath(), e);
        }
    }

    public <T> T deserialize(@NonNull String filePath, @NonNull Class<T> clazz) {
        return deserialize(Path.of(filePath), clazz);
    }



    public String serialize(@NonNull Object obj) {
        try {
            return yamlMapper.writeValueAsString(obj);
        } catch (IOException e) {
            throw new IllegalStateException("转换 YAML 配置失败", e);
        }
    }

    /** 文件落盘由框架统一保证原子替换。 */
    public void write(Path path, Object value) {
        try {
            AtomicFileWriter.write(path, temporary -> yamlMapper.writeValue(temporary.toFile(), value));
        } catch (IOException e) {
            throw new IllegalStateException("保存 YAML 配置失败: " + path, e);
        }
    }

    public <P> YamlListCodec<P> listCodec(TypeReference<List<P>> type) {
        return new YamlListCodec<>() {
            @Override
            public List<P> read(Path path) { return deserialize(path, type); }
            @Override
            public void write(Path path, List<P> records) { YamlSerializer.this.write(path, records); }
        };
    }
}
