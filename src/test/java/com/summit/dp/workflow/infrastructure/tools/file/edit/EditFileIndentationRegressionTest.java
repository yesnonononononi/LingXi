package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * edit_file REPLACE 的缩进回归：规范化回退路径必须消费掉被替换行的原缩进，
 * 否则「文件原有前导空白」会与「newText 自带缩进」字面叠加，使源码首行缩进翻倍。
 *
 * <p>触发条件是精确 {@code indexOf} 失败、退回 {@code TextNormalizer.findAll} 的规范化匹配；
 * 精确匹配路径本就不受影响，两条用例分别锁住这两条路径的行为一致性。</p>
 */
class EditFileIndentationRegressionTest {

    /** 构造目标源码：{@code int value} 行缩进为 8 个空格，与 newText 自带缩进同宽。 */
    private static final String FILE_CONTENT =
            "public class A {\n"
                    + "    void m() {\n"
                    + "        int value = first;\n"
                    + "    }\n"
                    + "}\n";

    /** 期望结果：首行缩进恰好 8 个空格，与替换前一致，绝不翻倍成 16。 */
    private static final String EXPECTED_CONTENT =
            "public class A {\n"
                    + "    void m() {\n"
                    + "        int value = second;\n"
                    + "    }\n"
                    + "}\n";

    private static final Charset UTF_8 = StandardCharsets.UTF_8;
    private static final Integer AROUND_LINES = 3;

    /**
     * 精确匹配路径：oldText 与文件逐字一致，{@code indexOf} 命中，不走规范化。
     * 修复前该路径已正确，用作对照，确保修复未破坏精确路径行为。
     */
    @Test
    @DisplayName("精确匹配路径：首行缩进保持 8 空格，不翻倍")
    void exactMatchKeepsSingleIndent() {
        EditFileRequest request = EditFileRequest.builder()
                .type("REPLACE")
                .oldText("        int value = first;")
                .newText("        int value = second;")
                .build();

        FileEditorResult result = FileEditor.edit(request, FILE_CONTENT, UTF_8, AROUND_LINES);

        assertTrue(result.isSuccess(), () -> "编辑应成功，实际错误：" + result.getErrMsg());
        assertEquals(EXPECTED_CONTENT, result.getData().newContent());
        assertEquals(8, firstReplaceLineIndent(result), "替换行首行缩进必须是 8 个空格");
    }

    /**
     * 规范化回退路径：oldText 与文件仅空白差异（{@code int  value} 双空格 vs 文件 {@code int value}），
     * 使 {@code indexOf} 失败并退回 {@code findAll}。修复前该用例必红——规范化匹配把起点落在行首
     * 空白之后的首个字符上，拼接时原 8 空格缩进被保留，再叠加 newText 的 8 空格，得到 16 空格。
     */
    @Test
    @DisplayName("规范化回退路径：首行缩进保持 8 空格，不翻倍")
    void normalizedFallbackKeepsSingleIndent() {
        EditFileRequest request = EditFileRequest.builder()
                .type("REPLACE")
                .oldText("        int  value = first;")
                .newText("        int value = second;")
                .build();

        FileEditorResult result = FileEditor.edit(request, FILE_CONTENT, UTF_8, AROUND_LINES);

        assertTrue(result.isSuccess(), () -> "编辑应成功，实际错误：" + result.getErrMsg());
        assertEquals(EXPECTED_CONTENT, result.getData().newContent());
        assertEquals(8, firstReplaceLineIndent(result), "规范化回退后首行缩进必须仍是 8 个空格");
    }

    /** 取结果中新内容里含 {@code int value = second;} 的那一行的前导空格数。 */
    private static int firstReplaceLineIndent(FileEditorResult result) {
        String line = result.getData().newContent().lines()
                .filter(text -> text.contains("int value = second;"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("结果中未找到替换后的目标行"));
        return line.length() - line.stripLeading().length();
    }
}
