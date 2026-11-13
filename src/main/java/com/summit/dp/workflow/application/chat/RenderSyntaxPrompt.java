package com.summit.dp.workflow.application.chat;

import org.springframework.stereotype.Component;

/**
 * 产品自定义的 Markdown 渲染语法说明：告诉模型「界面会把哪些写法渲染成可交互组件」。
 *
 * <p>这些语法是前后端共同约定的契约，不是可以随场景自由发挥的文案：前端
 * {@code utils/localFileLink.ts} 决定哪条链接算本地文件，{@code utils/markdown.ts} 决定
 * Mermaid 围栏与代码块怎么渲染。所以本段只在这里维护一份，模型侧要能照着写出来。</p>
 *
 * <p>它单独成段而不是塞进 {@code lingxi.system-prompt}：那段是用户可改的 Agent 工作规范，
 * 这段是产品能力说明 —— 混在一起后，改工作规范的人会顺手删掉产品的渲染契约。</p>
 */
@Component
public class RenderSyntaxPrompt {

    /**
     * 渲染语法段。改动时同步 {@code RenderSyntaxPromptTest} 与前端
     * {@code tests/localFileLink.test.ts}、{@code tests/filePreview.smoke.cjs}。
     *
     * <p>去尾换行：本段要参与 {@code String.join("\n\n", ...)}，带着自己的尾换行会多出一个空行。</p>
     *
     * <p>公开常量是为了让跨包的提示词契约测试引用同一份文本，而不是各自复制一份字符串。</p>
     */
    public static final String SECTION = """
            # 产品渲染语法

            聊天界面会把下列 Markdown 写法渲染成可交互组件：用户看到的是组件，不是原始文本。
            需要让用户「打开某个文件」「看一张图」时用这些写法，别让用户自己去找。

            ## 本地文件链接

            写法：`[显示文本](/绝对路径:行号)`，行号可以省略。

            - 例：`[预览 file-preview.cjs](/D:/Code/LingXi/frontend/electron/file-preview.cjs:34)`
            - 界面表现：带文件图标的蓝色标签，点击后右侧预览面板打开该文件并定位到该行；
              行号徽标由界面补，链接文本里不必再写行号。
            - 必须是本机绝对路径：Windows 盘符路径（`D:/x/a.ts`，反斜杠写法 `C:\\x\\a.ts` 同样支持）
              或 POSIX 绝对路径（`/home/x/a.py`）。相对路径、`file://`、`http(s)://` 都不走这条链路。
            - 路径含空格时把空格写成 `%20`，否则 Markdown 解析不出链接。
            - 失效情况：整条链接被反引号或代码块包裹（那是「展示语法」，不是「用语法」）；
              写成相对路径（只会变成跳到浏览器的外链，不会打开预览面板）。
            - 只在你确认过路径与行号时使用，不要凭印象编造；行号要与你引用的代码对得上。

            ## Mermaid 图表

            - 用 ```mermaid 围栏书写，正文按 Mermaid 语法（flowchart / sequenceDiagram / classDiagram /
              stateDiagram / gantt / pie 等）。
            - 围栏必须闭合：未闭合会被当成还在流式输出的未完成图表。
            - 图用来表达结构与流程，不要把大段正文塞进节点标签。

            ## 代码块

            - 用带语言标识的围栏（```java、```ts、```vue 等），界面会语法高亮并提供复制按钮。
            - 行内代码用单反引号。
            """.strip();

    /** 返回本段提示词正文；空串表示本次不注入。 */
    public String load() {
        return SECTION;
    }
}
