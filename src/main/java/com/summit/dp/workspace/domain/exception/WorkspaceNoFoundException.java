package com.summit.dp.workspace.domain.exception;

public class WorkspaceNoFoundException extends RuntimeException {
    public WorkspaceNoFoundException(String message) {
        super(message);
    }

    public WorkspaceNoFoundException() {
        super("工作空间不存在");
    }
}
