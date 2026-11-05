# 桌宠 GIF 补充资产 v1

本批补齐适合短循环的坐姿眨眼、抱云关键帧、小云酱开心反馈，以及一条四段玩耍动画。
状态为 `awaiting-visual-review`：已生成并完成自动校验，尚未接入桌宠运行时，也不代表 M2 全部完成。

| 成品 | 帧数 | 时长 | 用途 |
| --- | --- | --- | --- |
| `gifs/sit_blink.gif` | 7 | 6.61 秒 | 坐姿自然眨眼，含一次双眨眼 |
| `gifs/cloud_react.gif` | 8 | 3.18 秒 | 小云酱闭眼开心、轻跳后落回原位 |
| `gifs/play_cloud.gif` | 15 | 4.86 秒 | 靠近、接触抱起、回应、放回；角色分层 |

直接打开 `preview.html` 可看循环并切换明暗背景；`qa/review.png` 是明暗底对照，`qa/play_frames.png` 按播放顺序排出全部玩耍帧。

## 资产边界

- `frames/` 有 4 张新增透明原生关键帧、各自的 2× 最近邻母版，以及独立手掌前景层。中性帧复用已验收资产，不复制存储。
- 主角与伙伴分别保存。`manifest.json` 包含各段时序、位置、握持点和叠放顺序，工程接入可直接按 PNG 分层播放。
- 原图轮廓、alpha、脚底和声明区域外像素逐字节保持不变。生成图只贡献眼部、嘴部、手臂等必要区域，背景光晕不进入成品。
- GIF 是 256 色、二值透明的动画交付物；保留完整 alpha 的 PNG 才是后续接入母版。
- 本批放在 `supplemental/`，避免未审核资产自动进入已验收的六批 pose 契约；未修改已有批次、前端代码或运行时清单。
- `side`、`edge`、`mini` 需要新视角、接触几何或专用轮廓，本批未用 GIF 冒充完成。坐姿持续呼吸、耳尾微动也仍待补齐。

## 复算与校验

在仓库根运行，工具均为纯 Node、零新增依赖：

```powershell
node docs/assets/desktop-pet/supplemental/gif-v1/tools/build.mjs
node docs/assets/desktop-pet/supplemental/gif-v1/tools/check.mjs
node --test docs/assets/desktop-pet/supplemental/gif-v1/tools/check.test.mjs
```

校验包含文件摘要、闭眼虹膜消失、区域外零变化、alpha 零变化、母版最近邻关系、GIF 帧数与时序、透明清帧、四段玩耍和首尾位置一致。
变异用例验证睁眼回退、区域外坏点、alpha 漂移、删回应阶段、取消清帧均会失败。GIF 另由已安装的 libvips/sharp 独立完整解码，结果见 `qa/validation.json`。

## 生成来源

使用内置 `image_gen`，以既有坐姿和小云酱为编辑参考；4 张直出图在 `source/`，提示词在 `prompts.md`。
PNG 编解码器复用已交付 sit 批次；GIF 编码、合成与校验可在不调用生图服务的情况下复算。
