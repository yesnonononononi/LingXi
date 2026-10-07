package com.summit.dp.shared.skill;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Skill 根目录的解析与降级边界。
 *
 * <p>框架的 {@code FileSystemSkillLoader} 把「配了目录却不存在」判为错误而不是空目录，
 * 所以业务侧要么保证目录在、要么根本不传 —— 这里的每个分支都对应这两条路之一。</p>
 */
class SkillRootResolverTest {

    @TempDir
    Path tempDir;

    @Test
    @DisplayName("目录不存在：建出来后就绪（不能指望框架容错）")
    void missingDirectoryIsCreated() {
        Path absent = tempDir.resolve("skill");
        assertFalse(Files.exists(absent), "前置：该目录确实不存在");

        Path root = new SkillRootResolver(absent.toString()).root();

        assertEquals(absent.toAbsolutePath().normalize(), root);
        assertTrue(Files.isDirectory(root), "必须建出来：否则框架加载器会直接抛错，每次执行都失败");
    }

    @Test
    @DisplayName("已存在的目录：原样返回，不重复创建")
    void existingDirectoryIsReused() {
        Path existing = tempDir.resolve("skill");
        assertTrue(existing.toFile().mkdirs());

        assertEquals(existing.toAbsolutePath().normalize(), new SkillRootResolver(existing.toString()).root());
    }

    @Test
    @DisplayName("置空即关闭：不下发 Skill")
    void blankConfigDisablesSkill() {
        assertNull(new SkillRootResolver("").root(), "空串是「关掉这个能力」的显式开关");
        assertNull(new SkillRootResolver("   ").root(), "全空白等同于未配置");
        assertNull(new SkillRootResolver(null).root());
    }

    @Test
    @DisplayName("路径被同名文件占住：降级为「无 Skill」，而不是让每次执行都抛错")
    void unusablePathDegradesInsteadOfFailingRequests() throws Exception {
        Path occupied = tempDir.resolve("skill");
        Files.writeString(occupied, "not a directory");

        assertNull(new SkillRootResolver(occupied.toString()).root(),
                "建不出目录只应降级：Skill 是可选能力，不能因为它让每一次执行都在装配提示词时失败");
    }
}
