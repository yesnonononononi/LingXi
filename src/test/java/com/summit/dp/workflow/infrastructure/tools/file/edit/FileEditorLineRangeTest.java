package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 编辑行号区间：0 表示该侧不存在，四种编辑类型必须正交 —— REPLACE 双侧、DELETE 只有旧侧、
 * INSERT 只有新侧、新建文件只有从第 1 行起的新侧。
 */
class FileEditorLineRangeTest {

    private static final int AROUND_LINES = 3;

    @Test
    void replaceWithinSingleLineCoversOneLineOnBothSides() {
        FileEditorResult.ContentInfo info = edit(replace("beta", "BETA"), "alpha\nbeta\n");

        assertEquals(2, info.oldStartLine());
        assertEquals(2, info.oldEndLine());
        assertEquals(2, info.newStartLine());
        assertEquals(2, info.newEndLine());
    }

    @Test
    void replaceSpanningLinesReportsOldSpanAndNewSpan() {
        FileEditorResult.ContentInfo info = edit(replace("b\nc", "X\nY\nZ"), "a\nb\nc\nd\n");

        // 旧侧覆盖 b、c 两行；新侧写满三行，二者不必相等。
        assertEquals(2, info.oldStartLine());
        assertEquals(3, info.oldEndLine());
        assertEquals(2, info.newStartLine());
        assertEquals(4, info.newEndLine());
    }

    @Test
    void trailingNewlineInNewTextDoesNotAddAnExtraLine() {
        FileEditorResult.ContentInfo info = edit(replace("b\nc", "X\n"), "a\nb\nc\nd\n");

        assertEquals(2, info.newStartLine());
        assertEquals(2, info.newEndLine());
    }

    @Test
    void deleteKeepsOnlyOldSide() {
        FileEditorResult.ContentInfo info = edit(delete("b\n"), "a\nb\nc\n");

        assertEquals(2, info.oldStartLine());
        assertEquals(2, info.oldEndLine());
        assertEquals(0, info.newStartLine());
        assertEquals(0, info.newEndLine());
    }

    @Test
    void insertAfterAnchorStartsOnAnchorLine() {
        FileEditorResult.ContentInfo info = edit(insert("INSERT_AFTER", "a", "X\n"), "a\nb\n");

        assertEquals(0, info.oldStartLine());
        assertEquals(0, info.oldEndLine());
        assertEquals(1, info.newStartLine());
        assertEquals(1, info.newEndLine());
    }

    @Test
    void insertBeforeAnchorStartsOnAnchorLine() {
        FileEditorResult.ContentInfo info = edit(insert("INSERT_BEFORE", "b", "X\nY\n"), "a\nb\n");

        assertEquals(2, info.newStartLine());
        assertEquals(3, info.newEndLine());
    }

    @Test
    void newFileStartsAtFirstLine() {
        FileEditorResult.ContentInfo info = edit(insert("INSERT_AFTER", null, "l1\nl2\n"), "");

        assertEquals(0, info.oldStartLine());
        assertEquals(0, info.oldEndLine());
        assertEquals(1, info.newStartLine());
        assertEquals(2, info.newEndLine());
    }

    @Test
    void insertionAtEndOfFileStartsOnTheNextLine() {
        // anchorEnd 等于内容长度：新内容落在文件末尾之后的第 3 行，不是第 2 行的行内。
        FileEditorResult.ContentInfo info = edit(insert("INSERT_AFTER", "b\n", "X\n"), "a\nb\n");

        assertEquals(3, info.newStartLine());
        assertEquals(3, info.newEndLine());
    }

    @Test
    void emptyInsertionCollapsesToTheInsertionLine() {
        // 插入空字符串是无操作编辑：新侧区间退化成插入点那一行，不能算出 0 或负数行号。
        FileEditorResult.ContentInfo info = edit(insert("INSERT_AFTER", "a", ""), "a\nb\n");

        assertEquals(1, info.newStartLine());
        assertEquals(1, info.newEndLine());
        assertEquals("a\nb\n", info.newContent());
    }

    @Test
    void editResultStillCarriesFullContentsForWriting() {
        FileEditorResult.ContentInfo info = edit(replace("beta", "BETA"), "alpha\nbeta\n");

        assertTrue(info.newContent().contains("BETA"));
        assertEquals("alpha\nbeta\n", info.oldContent());
    }

    private FileEditorResult.ContentInfo edit(EditFileRequest request, String content) {
        FileEditorResult result = FileEditor.edit(request, content, StandardCharsets.UTF_8, AROUND_LINES);
        assertTrue(result.isSuccess(), result.getErrMsg());
        return result.getData();
    }

    private EditFileRequest replace(String oldText, String newText) {
        return EditFileRequest.builder().type("REPLACE").path("demo.txt")
                .oldText(oldText).newText(newText).build();
    }

    private EditFileRequest delete(String oldText) {
        return EditFileRequest.builder().type("DELETE").path("demo.txt").oldText(oldText).build();
    }

    private EditFileRequest insert(String type, String anchor, String newText) {
        return EditFileRequest.builder().type(type).path("demo.txt").anchor(anchor).newText(newText).build();
    }
}
