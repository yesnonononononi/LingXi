package com.summit.dp.workflow.infrastructure.tools.file.record;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * 记录链的连续性判据：内容摘要。
 *
 * <p><b>为什么需要它</b>：基线 + 逐条 diff 的前提是「上一条的末态就是下一条的开头」。这个前提
 * 只有 {@code edit_file} 才会维持；用 shell / python / 甚至 {@code del} 直接改文件都不会留下记录，
 * 链就断在中间，后续 diff 的上下文对不上（{@code CONTENT_DOES_NOT_MATCH_TARGET}）。
 * 登记下一条时拿「上一条的末态摘要」和「本次改之前的摘要」比一次，断没断当场就知道。</p>
 *
 * <p><b>为什么是摘要不是正文</b>：比对只发生在登记时，存正文等于把 P2/P3 消掉的写放大再搬回来。
 * 64 个十六进制字符足够，且能顺手支持人工核对。</p>
 */
public final class ContentDigest {

    private ContentDigest() {
    }

    /**
     * 计算内容摘要。
     *
     * @param content 文件全文；{@code null} 表示文件此时不存在，与空文件同一状态
     * @return SHA-256 的十六进制形态
     */
    public static String compute(String content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hashed);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("当前 JVM 不支持 SHA-256", e);
        }
    }
}
