package com.summit.dp.workspace.domain.model;

/**
 * 工作空间类型。
 * <p>{@code DOCKER} 对应框架 {@code DockerWorkspace}（容器内执行，workDir 为容器内绝对路径），
 * {@code LOCAL} 对应业务自建的本地工作空间（主机目录直接执行）。</p>
 */
public enum WorkspaceType {
    DOCKER("docker"),
    LOCAL("local");

    private final String code;

    WorkspaceType(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }

    /**
     * 按存储/入参字符串解析类型，大小写不敏感；非法值抛 {@link IllegalArgumentException}。
     */
    public static WorkspaceType fromCode(String code) {
        if (code == null || code.isBlank()) {
            throw new IllegalArgumentException("工作空间类型不能为空");
        }
        for (WorkspaceType type : values()) {
            if (type.code.equalsIgnoreCase(code.trim())) {
                return type;
            }
        }
        throw new IllegalArgumentException("不支持的工作空间类型: " + code);
    }
}
