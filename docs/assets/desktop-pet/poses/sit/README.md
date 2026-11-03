# 坐姿中性静帧 · M2 首验包

任务书第8节要求「坐姿先交静帧，主理人确认风格与几何自洽后再做关键帧」。本包仅交 `sit_neutral@2x.png`，状态为待人工确认；不是完整 sit 批次，更不是 M2 全量资产。

## 查看与复算

- 打开 `preview.html` 查看站/坐同尺、深浅底与放大图；`qa/sit_review.png` 是便于直接查看的并排图。
- 目录树、全部交付文件的字节数与 SHA256 见 `delivery-files.txt`（清单自身不自哈希）。
- 本目录 `.gitattributes` 将文本固定为 LF，保证检出后仍可逐字节对账。
- `manifest.json` 保存母版和来源图的实测值；bbox 的 right/bottom 均含端点，判定条件为 alpha>0。
- `source/sit_neutral_generated.png` 是生成工具原始结果，仅用于溯源，含低 alpha 噪点，禁止用作运行时资产。
- `source/sit_neutral_native.png` 是清理、等比排版后的原生图；母版由其2倍最近邻导出，没有新增细节。
- `prompts.json` 保存选用图的完整提示词和参考路径，使用内置 image_gen；生成本身不保证逐像素复现，后处理可以复算。

在仓库根目录运行（无需安装第三方依赖）：

```powershell
node docs/assets/desktop-pet/poses/sit/tools/build-sit.mjs
node docs/assets/desktop-pet/poses/sit/tools/build-preview.mjs
node docs/assets/desktop-pet/poses/sit/tools/check-sit.mjs --self-test
```

正式母版检查退出码为0。`qa/validation.txt` 保存原样 stdout/stderr 与退出码。9 个故意包含错误的金丝雀覆盖错误画布、错误位深、低 alpha、单像素孤岛、错误哈希/字节数/bbox、脚底错位和边缘留白不足；扫描器逐像素覆盖全画布，连通块使用8邻域。

完整批次门禁目前应退出1，防止静帧包被误报为整批完成：

```powershell
node docs/assets/desktop-pet/poses/sit/tools/check-sit.mjs --complete
```

## 几何与人工复核

| 项目 | 实测值 |
| --- | --- |
| 母版 | 2048×3072，8bit RGBA，非隔行，sRGB，straight alpha |
| 站位锚点 | (1024,2908) |
| bbox | (210,750)–(1837,2909)，含端点 |
| 画面左/右脚底接触点 | (599,2907) / (1309,2909) |
| 显示墨迹高度 | 164.53125px（画布按156×234显示） |
| 镜像 | 不安全；发侧蝴蝶结、云朵发夹和尾巴不得直接镜像 |

双腿向前伸、膝盖弯曲向两侧打开，白色靴底的粉色肉垫朝向观者；臀部坐地、裙摆铺开、双手放在腿前。头脸维持圆润比例，身体因屈膝而变矮。配饰与尾巴留在画面右侧，可以直接与既有站姿对照判断，不是压扁站姿。

alpha 清理只影响低 alpha 噪点、小于4px的孤岛与接近不透明的主体，不补画姿态；新绘图等比缩小到原生画布后再最近邻放大。PNG 直通透明度由导出流程保证，单凭文件头无法证明是否曾错误预乘，因此仍须在深浅底人工复核边缘。

## 未决项

- 待主理人确认本静帧的风格、身份一致性与坐姿几何。
- 确认后补坐姿抱云、坐姿眨眼及肉垫特写参数；`--complete` 会对缺项报错。
- lie / sleep / walk / run / jump / play / side / edge / mini 尚未制作；companion 不重复交付。
- 本包不包含动画时序、概率、工程接入或窗口几何代码。
