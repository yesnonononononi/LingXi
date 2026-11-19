package com.summit.dp.workflow.application.chat;

import org.springframework.stereotype.Component;

/**
 * 产品文档位置说明：告诉模型「产品自身的文档在哪里」。
 *
 * <p>解决的是这类翻车：用户问某个功能怎么用，模型手上没有文档，只能凭印象编；
 * 或者反过来，用户每次都得自己把文档路径贴过来才问得动。</p>
 *
 * <p>位置由客户端与打包流程决定（开发态 {@code frontend/public/docs}、打包后 {@code dist/docs}，
 * 点「查看文档」时镜像到用户数据目录的 {@code docs}），是产品事实而不是用户可改的规范，
 * 所以单独成段，不塞进 {@code lingxi.system-prompt} —— 那段是用户自己会编辑的工作规范，
 * 改偏好的人不该顺手把产品文档位置删掉。</p>
 */
@Component
public class ProductDocsPrompt {

    /**
     * 产品文档段。
     *
     * <p>去尾换行：本段要参与 {@code String.join("\n\n", ...)}，带着自己的尾换行会多出一个空行。</p>
     *
     * <p>公开常量是为了让提示词契约测试引用同一份文本，而不是各自复制一份字符串。</p>
     */
    public static final String SECTION = """
            # 产品文档

            产品自身的文档位于应用内的 `/docs` 目录。回答「这个功能怎么用」「扩展包怎么写」
            「某个入口在哪」这类产品问题时，先读 `/docs` 下的对应文档，不要凭印象猜。

            - 应用内路径：`/docs`，例如 `/docs/extension-packs-guide.html`
            - 本机镜像：应用用户数据目录下的 `docs` 子目录（Windows 上在 `%APPDATA%` 下
              以应用名命名的那个目录里），客户端「查看文档」打开的就是这一份，
              文件工具可以直接读其中的绝对路径；不确定具体路径时按运行中的应用名推导，
              不要猜成别的目录
            - 目录不存在或没有对应文档时，如实告诉用户当前版本没有这份文档，不要自行编造内容
            - 文档与实现冲突时以实现为准，并把差异一并说明给用户
            """.strip();

    /** 返回本段提示词正文；空串表示本次不注入。 */
    public String load() {
        return SECTION;
    }
}
