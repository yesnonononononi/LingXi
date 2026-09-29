package com.summit.dp.shared.model;

/**
 * 工作空间类型。
 * <p>{@code SAND_BOX} 对应框架沙箱环境（容器内执行，workDir 为容器内绝对路径），
 * {@code LOCAL} 对应业务自建的本地工作空间（主机目录直接执行）。</p>
 */
public enum WorkspaceType {
    SAND_BOX("sandbox"),
    NONE("none"),
    LOCAL("local");

    private final String code;

    WorkspaceType(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }

    /**
     * 按存储/入参字符串解析类型，大小写不敏感；支持 "sandbox" / "sand_box" / "local"；
     * 空值兜底返回 {@link #SAND_BOX}。
     */
    public static WorkspaceType fromCode(String code) {
        if (code == null || code.isBlank()) {
            return SAND_BOX;
        }
        String trimmed = code.trim();
        if ("sandbox".equalsIgnoreCase(trimmed) || "sand_box".equalsIgnoreCase(trimmed)) {
            return SAND_BOX;
        }
        if ("local".equalsIgnoreCase(trimmed)) {
            return LOCAL;
        }
        for (WorkspaceType type : values()) {
            if (type.code.equalsIgnoreCase(trimmed) || type.name().equalsIgnoreCase(trimmed)) {
                return type;
            }
        }
        throw new IllegalArgumentException("不支持的工作空间类型: " + code);
    }
}
