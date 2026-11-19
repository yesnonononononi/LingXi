package com.summit.dp.workflow.application.chat;

import org.springframework.stereotype.Component;

/**
 * 后端构建环境说明：客户端自带的运行时是裁剪过的，不能拿来编译。
 *
 * <p>这条是踩出来的：{@code JAVA_HOME} 被指到客户端打包的 jlink 运行时
 * （安装目录下的 {@code resources/backend/runtime}）时，Maven 编到一半才报
 * {@code No such compiler 'javac'}，报错点在 plexus/guice 深处，看不出是 JDK 的问题，
 * 很容易被当成"代码坏了"或"依赖坏了"，白折腾半天。</p>
 *
 * <p>写进提示词是为了让动后端的会话一开始就排除掉这个可能，而不是等构建失败再从头查。
 * 与渲染语法段同一性质：都是「环境是什么样」的客观事实，不随用户偏好改变。</p>
 */
@Component
public class DevEnvironmentPrompt {

    /**
     * 后端构建环境段。
     *
     * <p>去尾换行：本段要参与分段拼接，带着自己的尾换行会多出一个空行。</p>
     */
    public static final String SECTION = """
            # 后端构建环境

            客户端内置的 Java 运行时是 jlink 裁剪过的，只有 `java`，没有 `javac`，
            也不能用来编译。构建后端前先确认 `JAVA_HOME` 指向本机完整 JDK。

            - 症状：`JAVA_HOME` 指向安装目录下的运行时（形如 `resources/backend/runtime`）时，
              Maven 报 `No such compiler 'javac'`，堆栈落在 plexus / guice 注入里，
              看不出是 JDK 的问题
            - 排查：先看 `%JAVA_HOME%\\bin\\javac.exe` 是否存在，不存在就说明指错了
            - 做法：换成完整 JDK（本机装了哪个用哪个，可用 `where javac` 确认），
              不要用 IDE 安装目录或客户端安装目录里的运行时
            - 这属于环境问题而非代码问题：改代码不会让它通过，别顺着报错去改构建配置
            """.strip();

    /** 返回本段提示词正文；空串表示本次不注入。 */
    public String load() {
        return SECTION;
    }
}
