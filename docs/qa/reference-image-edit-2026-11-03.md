# 参考图润色验证（2026-11-03）

`generate_image` 新增可选 `reference_image_path`，接受工作区内单张 PNG/JPEG 的相对或绝对路径。后端校验并保留原图字节，构造带 MIME 类型的 Base64 图片对象；SDK 通过 multipart 上传到 `/images/edits`。输出仍另存文件，并沿用配额、预览与用量汇总。省略参考图时继续文生图。

框架补充普通编辑、蒙版编辑的单次规格重载。业务直接传递 `ImageGenerationOptions`，不通过改写模型配置规避接口缺口。旧提供者遇到不支持的规格会明确失败；SDK 编辑仅支持一张输出，不继承文生图的批量数量。

## 依赖与范围

- 框架分支：`codex/reference-image-edit`；提交：`e3fef3ff58d29600d440cd0af397605489f71049`。
- 独立工作区：`D:/Code/starter/.codex-worktrees/lingxi-reference-image-edit`，未纳入框架主工作区的在飞修改。
- 原锁定点 `14fafb9` 不含业务已使用的 `AgenticLoopListener`、`InterceptorType`，无法编译现有 `MemoryMonitorInterceptor`。补丁基于已提交的 `58c45d9`，业务锁定到补丁提交。
- 原完整流程用例只等待终态，可能早于完成事件的用量入账；现等待用量落库，仍严格断言总数为 125，未修改生产结算逻辑。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| 框架图片接口、适配器与真实 SDK 本地服务契约 | 20 条通过 |
| 业务工具、参考图、配额、规格、完整生图流程和静态契约 | 48 条通过，2 条跳过 |
| 框架锁定脚本 | 8 条通过 |

两个跳过用例分别检查输入、输出符号链接越界；当前 Windows 环境不允许创建符号链接。其余越界路径、无效参数、伪图片、损坏图片、字节及像素上限检查通过。

参考图请求覆盖 PNG/JPEG、相对/绝对路径四种组合，检查编辑接口、原图完整字节、MIME、尺寸、质量、自定义请求头、原文件不变、输出保存、预览与用量。模拟服务拒绝编辑时只请求一次、不转为文生图；保存失败仍保留已返回用量。远端工作区读取通过桥接验证。

手动变异均已恢复：

- 框架丢弃编辑规格、改用默认规格：2 条契约用例失败。
- 业务把参考图强制发往文生图接口：4 条用例失败，明确报出 `/images/edits` 与 `/images/generations` 不符；原文生图流程仍通过。

业务定向验证：

```powershell
mvn.cmd -o test '-Dtest=GenerateImageToolExecutorTest,GenerateImageReferenceTest,GenerateImageInterceptorTest,ImageGenerationSpecValidatorTest,ImageGenerationFlowTest,StaticToolDeclarationContractTest' '-Dlingxi.build.directory=D:/Code/LingXi/target/reference-image-edit'
node --test frontend/tests/frameworkDependencies.test.cjs
```

验证使用本地模拟服务，未调用真实图片服务。框架已安装到本机 Maven 仓库；未重打包客户端或重启后端。远端构建消费新锁定点前，需先推送框架分支。
