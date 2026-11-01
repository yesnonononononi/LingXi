# 三层记忆与项目 wiki

| 层次 | 默认路径 | 用途 |
| --- | --- | --- |
| 用户级记忆 | `%USERPROFILE%/.lingxi/memory/user/memory.md` | 跨项目的用户偏好和稳定约定 |
| 项目 wiki | `<项目>/.lingxi/memory/wiki/模块名.md` | 一个模块一个文件，保存职责、入口、约束、决策和已验证经验 |
| 工作记忆 | `<项目>/.lingxi/memory/work/yyyy-MM-dd.md` | 当日进度、临时决策、阻塞和待办 |

主执行和子执行均在创建请求时，由 `BusinessSystemPromptBuilder` 将记忆规则和当前项目的 wiki 目录加入 `AgentRequest.systemPrompt`。目录按名称排序，最多 30 条，另外受字符预算限制；不预载正文。同次执行直接使用已定稿的系统提示词，恢复时也沿用检查点，不通过循环拦截器改写上下文。目录未变化时，构建结果保持一致。

- `load_memory({})`：列出最多 30 条目录。
- `load_memory({"wikiName":"存储.md"})`：读取一个 wiki 的正文。
- `search_wiki({"keyword":"检查点"})`：检索全部 wiki 的名称和正文，返回总命中数、实际返回数以及最多 30 条名称和短片段，不局限于初始目录。
- 空关键词只列名称；返回内容同时受字符预算限制，保持完整 JSON。未选项目或目录加载失败不阻断正常交流。

用户级记忆通过 `lingxi.memory.user.location` 和 `max-tokens` 配置；项目 wiki 与工作记忆目录分别由 `lingxi.memory.wiki.relative-location`、`lingxi.memory.work.relative-location` 配置。项目目录只取当前请求绑定的真实工作空间，不回落到进程目录。

旧 `.lingxi/memory/consistent/memory.md` 与 `.lingxi/wikis` 保留为迁移来源。遇到相关旧知识时，核实后按模块提炼到新 wiki；不自动删除或覆盖旧文件，不再继续维护旧项目单文件。用户级旧记忆可核实后合并到新的用户记忆文件。
