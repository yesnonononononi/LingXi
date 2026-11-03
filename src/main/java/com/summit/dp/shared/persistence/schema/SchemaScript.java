package com.summit.dp.shared.persistence.schema;

/**
 * 一个建库版本脚本：版本号、文件名、正文、以及正文的指纹。
 *
 * <p>{@code checksum} 是「脚本被偷偷改过」的检出手段：版本登记表里记下当时执行的那份正文的指纹，
 * 下次启动比对不上就拒绝启动。脚本改了就升版本号，不要原地改已发布的脚本。</p>
 *
 * @param version  版本号（来自文件名 {@code V<版本>__<说明>.sql}）
 * @param filename 文件名，仅用于日志与登记表
 * @param content  脚本正文（UTF-8 解码后）
 * @param checksum 正文的 SHA-256（十六进制小写）
 */
public record SchemaScript(int version, String filename, String content, String checksum) {

    /** 结构校验：版本号必须为正、正文不能为空，避免「空脚本登记成功」这种假成功。 */
    public SchemaScript {
        if (version <= 0) {
            throw new IllegalArgumentException("建库脚本版本号必须为正: version=" + version);
        }
        if (filename == null || filename.isBlank()) {
            throw new IllegalArgumentException("建库脚本文件名不能为空: version=" + version);
        }
        if (content == null || content.isBlank()) {
            throw new IllegalArgumentException("建库脚本正文不能为空: " + filename);
        }
        if (checksum == null || checksum.isBlank()) {
            throw new IllegalArgumentException("建库脚本指纹不能为空: " + filename);
        }
    }

    /** 前 N 个字符的正文摘要，用于「第几条语句失败」这类报错。 */
    public String preview() {
        String single = content.replaceAll("\\s+", " ").strip();
        return single.length() <= 80 ? single : single.substring(0, 80);
    }
}
