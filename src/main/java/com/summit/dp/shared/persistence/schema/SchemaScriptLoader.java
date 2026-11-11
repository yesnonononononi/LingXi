package com.summit.dp.shared.persistence.schema;

import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 逐条执行才能定位失败语句，脚本指纹用于阻止已登记版本被原地改写。 */
public class SchemaScriptLoader {

    /** 脚本命名：V<版本>__<说明>.sql；版本号决定执行顺序。 */
    private static final Pattern SCRIPT_NAME = Pattern.compile("^V(\\d+)__(.+)\\.sql$");

    /** 建库不能删除既有数据，升级只能走显式版本脚本。 */
    private static final Pattern DESTRUCTIVE = Pattern.compile(
            "(?im)^\\s*(?:DROP\\s+TABLE|TRUNCATE\\s+TABLE)\\b");

    /**
     * 读 classpath 上的全部版本脚本，按版本号升序。
     *
     * @param location classpath 通配位置，例如 {@code classpath*:db/h2/V*__*.sql}
     * @return 版本脚本列表（可能为空，调用方决定「空」是否算错）
     * @throws IllegalStateException 读取失败或版本号重复
     */
    public List<SchemaScript> load(String location) {
        if (location == null || location.isBlank()) {
            throw new IllegalArgumentException("建库脚本位置不能为空");
        }
        List<SchemaScript> scripts = new ArrayList<>();
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver().getResources(location);
            for (Resource resource : resources) {
                String filename = resource.getFilename();
                if (filename == null) {
                    continue;
                }
                Matcher matcher = SCRIPT_NAME.matcher(filename);
                if (!matcher.matches()) {
                    continue;
                }
                String content = stripBom(new String(resource.getInputStream().readAllBytes(),
                        StandardCharsets.UTF_8));
                scripts.add(new SchemaScript(Integer.parseInt(matcher.group(1)), filename, content,
                        checksum(content)));
            }
        } catch (IOException e) {
            throw new IllegalStateException("读取建库脚本失败: " + location + "，原因=" + e.getMessage(), e);
        }
        return orderByVersion(scripts);
    }

    /**
     * 按版本号升序排列并校验版本号唯一。
     *
     * <p>独立成方法是为了能被直接断言：执行顺序错了会让「先建表再加列」的脚本链无声跑反，
     * 而 classpath 资源的返回顺序并不在契约内（不同文件系统/打包方式会变）。</p>
     *
     * @param scripts 待排序脚本
     * @return 升序新列表
     * @throws IllegalStateException 版本号重复
     */
    public List<SchemaScript> orderByVersion(List<SchemaScript> scripts) {
        List<SchemaScript> ordered = new ArrayList<>(scripts);
        ordered.sort(Comparator.comparingInt(SchemaScript::version));
        Set<Integer> versions = new HashSet<>();
        for (SchemaScript script : ordered) {
            if (!versions.add(script.version())) {
                throw new IllegalStateException("建库脚本版本号重复: V" + script.version());
            }
        }
        return ordered;
    }

    /**
     * 正文的 SHA-256（十六进制小写，UTF-8 字节）。
     *
     * <p><b>先规范化再算</b>：同一份 SQL 在 Windows 工作区（{@code core.autocrlf=true}）与仓库里的
     * 换行符不同，若直接对原始字节取哈希，一次 {@code git checkout}、IDE「保存时格式化」或粘贴
     * 就会让已登记版本的指纹对不上，表现为「脚本被偷偷改过」而拒绝启动 —— 其实一个字节的 SQL
     * 语义都没变。指纹要守的是「内容被改」，不是「工作区重写过」。</p>
     *
     * @param content 脚本正文
     * @return 64 位十六进制串
     */
    public String checksum(String content) {
        return sha256(canonicalize(content));
    }

    /**
     * 该正文一切「可接受」的指纹：规范化口径 + 历史直算口径。
     *
     * <p><b>为什么不能只留规范化口径</b>：指纹是单向哈希，库里已登记的旧值是按当时那份原始字节
     * 算的，无法回推。因此候选集合同时包含：</p>
     * <ul>
     *   <li>规范化正文（LF）的指纹 —— 新口径；</li>
     *   <li>全 CRLF / 全 CR 变体的指纹 —— 覆盖「工作区被 git、IDE 整体改写过」；</li>
     *   <li>原始字节（剥 BOM 后原样）的指纹 —— 覆盖历史直算口径，其中包含混用换行符的文件
     *       （实测 V7 就是 6 个 CRLF 混 22 个 LF，任何枚举式变体都命中不到）。</li>
     * </ul>
     *
     * <p>候选集合只由正文推导，正文真被改（哪怕只改一句注释）时所有口径同时变化，
     * 仍然会命中「被修改」的拒绝分支。</p>
     *
     * @param content 脚本正文
     * @return 指纹候选集合（去重，至少一个）
     */
    public Set<String> acceptedChecksums(String content) {
        String canonical = canonicalize(content);
        Set<String> accepted = new LinkedHashSet<>();
        accepted.add(sha256(canonical));
        accepted.add(sha256(canonical.replace("\n", "\r\n")));
        accepted.add(sha256(canonical.replace("\n", "\r")));
        accepted.add(sha256(stripBom(content)));
        return accepted;
    }

    /**
     * 已登记指纹是否仍对应当前正文（换行符口径无关）。
     *
     * @param registered 版本登记表里存的指纹
     * @param content    当前正文
     * @return true 表示脚本没被改动
     */
    public boolean matchesRegistered(String registered, String content) {
        if (registered == null || registered.isBlank() || content == null) {
            return false;
        }
        return acceptedChecksums(content).contains(registered.strip().toLowerCase(java.util.Locale.ROOT));
    }

    /**
     * 正文规范化：剥 BOM、换行符统一成 LF。
     *
     * <p>规范化后的正文同时用于指纹与语句切分，两者口径因此永远一致。</p>
     *
     * @param content 原始正文
     * @return 规范化正文
     */
    public static String canonicalize(String content) {
        if (content == null) {
            throw new IllegalArgumentException("规范化需要正文");
        }
        return stripBom(content).replace("\r\n", "\n").replace('\r', '\n');
    }

    /** 对给定字符串直接取 SHA-256（十六进制小写）。 */
    private static String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            // 容量按 SHA-256 的固定十六进制长度（64）预留，不靠 hash.length * 2 现算。
            StringBuilder hex = new StringBuilder(64);
            for (byte value : hash) {
                hex.append(Character.forDigit((value >> 4) & 0xF, 16));
                hex.append(Character.forDigit(value & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("当前 JVM 不支持 SHA-256", e);
        }
    }

    /**
     * 拒绝破坏性脚本（{@code DROP TABLE} / {@code TRUNCATE TABLE}）。
     *
     * @param script 待执行的脚本
     * @throws IllegalStateException 命中破坏性语句
     */
    public void requireNonDestructive(SchemaScript script) {
        if (script == null) {
            throw new IllegalArgumentException("脚本不能为空");
        }
        if (DESTRUCTIVE.matcher(script.content()).find()) {
            throw new IllegalStateException("建库脚本包含破坏性语句，已拒绝执行: " + script.filename());
        }
    }

    /**
     * 把脚本切成单条语句（保留行尾分号）。
     *
     * @param script 待切分的脚本
     * @return 按出现顺序排列的语句列表，每条都是可独立执行的完整语句
     * @throws IllegalStateException 末尾存在不完整语句
     */
    public List<String> splitStatements(SchemaScript script) {
        if (script == null) {
            throw new IllegalArgumentException("脚本不能为空");
        }
        List<String> statements = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        String content = stripBom(script.content());
        for (String rawLine : content.split("\n")) {
            String trimmed = rawLine.strip();
            if (trimmed.isEmpty() || trimmed.startsWith("--")) {
                continue;
            }
            current.append(rawLine).append('\n');
            if (trimmed.endsWith(";")) {
                statements.add(current.toString());
                current.setLength(0);
            }
        }
        if (!current.isEmpty()) {
            throw new IllegalStateException("建库脚本末尾存在不完整语句: " + script.filename());
        }
        return statements;
    }

    /** 剥除 UTF-8 BOM，防止首行注释被当成 SQL 或导致 H2 词法解析报错。 */
    public static String stripBom(String content) {
        if (content != null && content.startsWith("\uFEFF")) {
            return content.substring(1);
        }
        return content;
    }
}
