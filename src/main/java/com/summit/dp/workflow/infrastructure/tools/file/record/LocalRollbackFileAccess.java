package com.summit.dp.workflow.infrastructure.tools.file.record;

import com.summit.dp.workflow.application.filerecord.RollbackFileAccess;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

/**
 * 回滚的磁盘动作（UTF-8 整文件读写）。
 *
 * <p>基线与原文件都是工具以 UTF-8 写下的，这里不做编码探测也不做换行归一 —— 回填要的是字节级还原。
 * 只认常规文件：目录、符号链接都当作「不存在」，避免顺着链接写到盘上别处。</p>
 */
@Component
public class LocalRollbackFileAccess implements RollbackFileAccess {

    @Override
    public boolean exists(String absolutePath) {
        return absolutePath != null && Files.isRegularFile(Path.of(absolutePath));
    }

    @Override
    public Optional<String> read(String absolutePath) {
        if (!this.exists(absolutePath)) {
            return Optional.empty();
        }
        try {
            return Optional.of(Files.readString(Path.of(absolutePath), StandardCharsets.UTF_8));
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    @Override
    public void write(String absolutePath, String content) {
        try {
            Files.writeString(Path.of(absolutePath), content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("写入回滚内容失败: " + absolutePath, e);
        }
    }

    @Override
    public void delete(String absolutePath) {
        try {
            Files.deleteIfExists(Path.of(absolutePath));
        } catch (IOException e) {
            throw new UncheckedIOException("删除回滚目标失败: " + absolutePath, e);
        }
    }
}
