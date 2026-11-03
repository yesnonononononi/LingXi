# 蒙版与输出选项验证（2026-11-03）

本次接入现有 SDK 的蒙版编辑、背景和输出格式参数。多图输入按要求暂缓，保持单张参考图、可选蒙版和单张输出，不另写 HTTP 客户端。

## 实现边界

- `mask_image_path` 经工作区校验读取，必须为带 alpha、存在完全透明区域的 PNG，并与参考图同尺寸。调用框架已有 `edit(image, mask, prompt, options)`。
- `ImageGenerationOptions` 增加 `background`、`outputFormat`，保留三参数构造与旧 JSON 兼容。生成、普通编辑、蒙版编辑均透传 SDK 原生字段；旧提供者不会静默丢掉输出要求。
- 工具暴露 `background=transparent|opaque|auto`、`output_format=png|jpeg`。透明输出必须保存为 PNG，省略格式时显式请求 PNG；扩展名冲突在调用前拒绝。
- 服务端原始返回格式、alpha 通道和透明像素按要求检查；不符时失败，保留已返回用量。格式检查先于现有转码，不能把 JPEG 转成 PNG 来充当服务端满足要求。
- 像素检查只验证透明属性，不保证主体轮廓、边缘或蒙版外区域逐像素不变。资产仍须自行运行几何与视觉验收。

SDK 来源为本机 `langchain4j-open-ai-1.22.0-sources.jar` 的 `OpenAiImageModel`，其 builder 已提供 `background`、`outputFormat`。接口字段也见 [OpenAI 图片编辑文档](https://developers.openai.com/api/reference/resources/images/methods/edit)。实际模型和网关是否支持，由服务端结果决定。

框架提交：`2f6fd86a985c37cd99008b24b49c47dd1bf2ba4e`，位于 `codex/reference-image-edit` 独立工作区；业务锁同步至该提交。

## 验证

| 范围 | 结果 |
| --- | --- |
| 框架图片接口、持久化、适配与 SDK 请求契约 | 23 条通过 |
| 业务蒙版、输出、参考图、规格、配额和完整生图流程 | 65 条通过，2 条跳过 |
| 框架依赖锁脚本 | 8 条通过 |

两个跳过用例沿用已有输入、输出符号链接检查，当前 Windows 环境不允许创建符号链接。新增蒙版及输出用例没有跳过。

业务使用不同字节的底图和蒙版，通过真实 SDK 发往本地模拟服务，检查 `image`、`mask`、`background`、`output_format` 及原始字节。反例覆盖缺少底图、蒙版尺寸不符、RGB、全不透明、只有半透明、JPEG、缺失及越界路径、无效参数。输出反例覆盖无 alpha、全不透明 RGBA、仅半透明、错误格式及不透明要求未满足；失败均保留用量。

手动变异已恢复：

- 去掉背景透传：框架契约 1 条失败。
- 去掉格式透传：框架契约 1 条失败。
- 将蒙版编辑退回普通编辑：业务真实请求检查 1 条失败。
- 跳过输出验收：5 条不合规输出用例全部失败。
- 跳过蒙版尺寸校验：尺寸反例因错误进入提供者而失败。

验证只使用本地模拟服务。框架产物已安装到本机 Maven 仓库，未调用真实图片服务、重启后端或重打包客户端。远端构建消费新锁定点前需推送框架分支。
