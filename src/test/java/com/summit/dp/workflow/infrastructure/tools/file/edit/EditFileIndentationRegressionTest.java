package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 精确匹配保留缩进，原文不一致时拒绝编辑，避免猜测位置后损坏源码。 */
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

    @Test
    @DisplayName("原文空白不一致时拒绝编辑")
    void whitespaceMismatchRejectsEdit() {
        EditFileRequest request = EditFileRequest.builder()
                .type("REPLACE")
                .oldText("        int  value = first;")
                .newText("        int value = second;")
                .build();

        FileEditorResult result = FileEditor.edit(request, FILE_CONTENT, UTF_8, AROUND_LINES);

        assertFalse(result.isSuccess());
        assertTrue(result.getErrMsg().contains("未找到完全一致的原文"));
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
