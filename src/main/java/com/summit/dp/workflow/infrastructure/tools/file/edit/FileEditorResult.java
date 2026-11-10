package com.summit.dp.workflow.infrastructure.tools.file.edit;

import lombok.Builder;

import lombok.Getter;

@Getter
@Builder
public class FileEditorResult {
    /**
     * 编辑结果：全文用于落盘，行号区间用于前端按行渲染 diff。
     *
     * <p>行号从 1 开始，{@code 0} 表示「该侧不存在」，四种编辑类型因此正交：</p>
     * <ul>
     *   <li>REPLACE：旧侧与新侧都有区间；</li>
     *   <li>DELETE：只有旧侧（新侧为 0，删除没有产生新行）；</li>
     *   <li>INSERT：只有新侧（旧侧为 0，插入没有覆盖旧行）；</li>
     *   <li>新建文件：只有新侧，且新侧从第 1 行开始。</li>
     * </ul>
     */
    @Builder
    public record ContentInfo(
            String oldContent,
            String newContent,
            int oldStartLine,
            int oldEndLine,
            int newStartLine,
            int newEndLine
    ) {

    }

    private int code;
    private String errMsg;
    private ContentInfo data;

    public boolean isSuccess() {
        return code == 1;
    }

    public static FileEditorResult success(ContentInfo data) {
        return FileEditorResult.builder()
                .code(1)
                .data(data)
                .build();
    }

    public static FileEditorResult success() {
        return FileEditorResult.builder()
                .code(1)
                .build();
    }

    public static FileEditorResult err(String errMsg) {
        return FileEditorResult.builder().code(0).errMsg(errMsg).build();
    }
}
