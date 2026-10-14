package com.summit.dp.shared.vo;

import java.nio.file.Path;

/**
 * 日志文件位置，供界面「点击跳转到文件预览」拼路径。
 *
 * @param dir       日志目录（绝对路径）
 * @param warnError WARN/ERROR 日志文件的绝对路径；预览面板直接打开它
 * @param exists    该文件此刻是否存在（刚启动、还没出过 WARN 时为 false，界面据此给「暂无日志」而不是报错）
 */
public record LogLocationVO(String dir, String warnError, boolean exists) {

    public static LogLocationVO of(Path dir, String fileName) {
        Path normalized = dir.toAbsolutePath().normalize();
        Path file = normalized.resolve(fileName);
        return new LogLocationVO(normalized.toString(), file.toString(), file.toFile().exists());
    }
}
