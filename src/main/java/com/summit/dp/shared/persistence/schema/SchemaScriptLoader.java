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
                String content = stripBom(new String(resource.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
                scripts.add(new SchemaScript(Integer.parseInt(matcher.group(1)), filename, content,
                        checksum(content)));
            }
        } catch (IOException e) {
            throw new IllegalStateException("读取建库脚本失败: " + location + "，原因=" + e.getMessage(), e);
        }
        scripts.sort(Comparator.comparingInt(SchemaScript::version));
        Set<Integer> versions = new HashSet<>();
        for (SchemaScript script : scripts) {
            if (!versions.add(script.version())) {
                throw new IllegalStateException("建库脚本版本号重复: V" + script.version());
            }
        }
        return scripts;
    }

    /**
     * 正文的 SHA-256（十六进制小写，UTF-8 字节）。
     *
     * @param content 脚本正文
     * @return 64 位十六进制串
     */
    public String checksum(String content) {
        if (content == null) {
            throw new IllegalArgumentException("计算脚本指纹需要正文");
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(content.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
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
