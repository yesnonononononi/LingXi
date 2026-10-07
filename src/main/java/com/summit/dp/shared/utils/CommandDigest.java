package com.summit.dp.shared.utils;

import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * 命令请求摘要：把「决定这一轮内容的字段」压成一个稳定短串。
 *
 * <p><b>为什么必须是稳定摘要而不是对象 hashCode</b>：摘要要跨进程、跨重启比同一次命令的两次
 * 请求。{@code hashCode} 受实例状态与字符串哈希种子影响，重启后同一内容可能算出不同值，
 * 幂等判定会整体失效。这里显式走 SHA-256，同一输入在任何进程里都是同一个串。</p>
 *
 * <p><b>为什么字段间要有分隔符</b>：直接拼接会让 {@code ["ab","c"]} 与 {@code ["a","bc"]}
 * 摘要相同 —— 那是两条不同的命令，却会被当成重试放行。统一用 {@code \u0001} 分隔，
 * 该字符不会出现在正常输入里。</p>
 */
public final class CommandDigest {

    /** 字段分隔符：选控制字符，避免与用户输入里可能出现的普通分隔符混淆。 */
    private static final char SEPARATOR = '\u0001';

    /** 参与摘要的最大图片字节数；超长图片只取头部，避免大图把摘要算到几十 MB。 */
    private static final int IMAGE_SAMPLE_BYTES = 64 * 1024;

    private CommandDigest() {
    }

    /**
     * 按给定顺序拼摘要。各字段允许为 {@code null}（拼成空串），调用方决定哪些字段参与。
     *
     * @param parts 参与摘要的字段值，按固定顺序传入
     * @return 十六进制小写摘要
     */
    public static String build(Object... parts) {
        StringBuilder joined = new StringBuilder();
        for (Object part : parts) {
            joined.append(text(part)).append(SEPARATOR);
        }
        return sha256Hex(joined.toString());
    }



    private static String text(Object value) {
        return value == null ? "" : value.toString();
    }


    private static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            // JDK 规范要求 SHA-256 必须存在，走到这里说明运行环境被裁剪过。
            throw new IllegalStateException("运行环境缺少 SHA-256 实现", e);
        }
    }
}
