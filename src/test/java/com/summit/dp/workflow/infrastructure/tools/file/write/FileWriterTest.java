package com.summit.dp.workflow.infrastructure.tools.file.write;

import com.summit.dp.workflow.infrastructure.tools.file.edit.FileEditorResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 整文件写入的纯计算：只算落盘后的全文与行号，失败路径不得产生任何结果。
 *
 * <p>行号是前端按行渲染差异的唯一依据，错一行就会把变动画在无关的行上。</p>
 */
class FileWriterTest {

    @Test
    void createStartsAtLineOneAndCountsEveryLine() {
        FileEditorResult.ContentInfo info = data(FileWriter.write(WriteType.CREATE, "a\nb", ""));

        assertEquals("a\nb", info.newContent());
        assertEquals(1, info.newStartLine());
        assertEquals(2, info.newEndLine());
        assertEquals(0, info.oldStartLine(), "新建没有旧侧，行号必须是 0 而不是 1");
        assertEquals(0, info.oldEndLine());
    }

    @Test
    void overridingReportsTheWholeOldAndNewRange() {
        FileEditorResult.ContentInfo info = data(FileWriter.write(WriteType.OVERRIDE, "x", "o1\no2\no3"));

        assertEquals(1, info.oldStartLine());
        assertEquals(3, info.oldEndLine());
        assertEquals(1, info.newStartLine());
        assertEquals(1, info.newEndLine());
    }

    @Test
    void prependingInsertsOnTheFirstLine() {
        FileEditorResult.ContentInfo info = data(FileWriter.write(WriteType.PREPEND, "头\n", "原"));

        assertEquals("头\n原", info.newContent());
        assertEquals(1, info.newStartLine());
        // 末尾换行只表示这一行结束，不多占一行：插入的内容只覆盖第 1 行。
        assertEquals(1, info.newEndLine());
        assertEquals(0, info.oldStartLine(), "插入不覆盖旧行");
    }

    @Test
    void appendingAfterATrailingNewlineStartsOnTheNextLine() {
        FileEditorResult.ContentInfo info = data(FileWriter.write(WriteType.APPEND, "尾", "原\n"));

        assertEquals("原\n尾", info.newContent());
        assertEquals(2, info.newStartLine());
        assertEquals(2, info.newEndLine());
    }

    @Test
    void appendingWithoutATrailingNewlineStaysOnTheSameLine() {
        FileEditorResult.ContentInfo info = data(FileWriter.write(WriteType.APPEND, "尾", "原"));

        // 工具不替人补换行：拼接是逐字的，行号也就落在原内容的最后一行。
        assertEquals("原尾", info.newContent());
        assertEquals(1, info.newStartLine());
        assertEquals(1, info.newEndLine());
    }

    @ParameterizedTest
    @ValueSource(strings = {"PREPEND", "APPEND"})
    void emptyFragmentIsARefusedWriteRatherThanAnEmptyWrite(String type) {
        FileEditorResult result = FileWriter.write(WriteType.fromString(type), "", "原有");

        assertFalse(result.isSuccess());
        assertTrue(result.getErrMsg().contains("OVERRIDE"), result.getErrMsg());
    }

    @Test
    void emptyContentIsAllowedWhenOverridingToAnEmptyFile() {
        FileEditorResult.ContentInfo info = data(FileWriter.write(WriteType.OVERRIDE, "", "清掉"));

        assertEquals("", info.newContent());
        assertEquals(0, info.newStartLine(), "空内容没有行可标");
        assertEquals(0, info.newEndLine());
    }

    private FileEditorResult.ContentInfo data(FileEditorResult result) {
        assertTrue(result.isSuccess(), result.getErrMsg());
        return result.getData();
    }
}
