package com.summit.dp.tools.baseTools.file.edit;

import lombok.Builder;

import lombok.Getter;

@Getter
@Builder
public class FileEditorResult {
    @Builder
    public record  ContentInfo(String oldContent,String newContent){

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
