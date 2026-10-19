# LingXi DeskPet

按 `E:\user\image` 原型图做的独立桌宠：Q 版猫娘，白毛、蓝眼、蓝蝴蝶结、猫耳、尾巴。

**独立工程，不依赖也不修改 LingXi 主应用。** 运行时只依赖 `electron`，渲染层零框架（原生 ES Module + SVG + CSS），没有构建步骤。

## 跑起来

```bash
cd deskpet
npm install          # 首次
npm start            # 或 npx electron .
```

## 操作

| 操作 | 效果 |
| --- | --- |
| 单击 | 换表情 + 冒一句台词；连点 3 下会翻脸 |
| 按住拖动 | 被拎起来（害羞脸），松手放下 |
| 右键 | 原生菜单：置顶、大小（100/125/150%）、躲起来、退出 |
| 托盘左键 | 把宠物叫回来 |
| 放着不管 90 秒 | 自己睡着，Zzz；点一下会惊醒 |

位置与缩放自动记到 `%APPDATA%/lingxi-deskpet/deskpet-config.json`。

## 目录

```
deskpet/
  main.js              主进程：透明窗口、拖动轮询、托盘、菜单、配置持久化
  preload.js           contextBridge 桥（只暴露桌宠需要的最小 API）
  src/
    index.html         无边框页面骨架
    styles.css         表情切换规则 + 呼吸/摆动/悬挂动画
    app.mjs            渲染层编排：状态机驱动、指针交互、气泡、眨眼
    pet.mjs            SVG 造物，分层绘制（改造型只动这个文件）
    state.mjs          状态机（纯逻辑，可单测）
    drag.mjs           拖拽/缩放几何（纯逻辑，可单测）
    palette.mjs        配色（取自原型图采样）
    bubbles.mjs        台词库
  scripts/
    gen-tray-icon.ps1  生成托盘图标 assets/tray.png
    smoke.cjs          Electron 冒烟：截 6 张表情图做视觉回归
  test/                node --test 单测
```

## 测试

```bash
npm test                                   # 纯逻辑单测，不需要 Electron
npx electron scripts/smoke.cjs             # 真渲染截图（产物写到 ../.lingxi/tmp）
```

## 配色

从原型图采样得到，单一真源在 `src/palette.mjs`；`src/styles.css` 的 `:root` 必须与之保持一致（有测试盯着）。

| 用途 | 色值 |
| --- | --- |
| 毛发 | `#FDFBF8` / 阴影 `#E9E2DC` |
| 皮肤 | `#FDF1E9` / 阴影 `#F6DFD5` |
| 腮红 | `#FBDED7` |
| 连衣裙 | `#EBDFD9` |
| 蝴蝶结 | `#A9C3DF` / 深 `#8FAFD1` |
| 眼睛 | `#7FA6CC` / 深 `#5E87B0` |

## 已知限制（第一版没做）

- **没有鼠标穿透**：窗口紧贴宠物包围盒，透明余量很小，但窗口矩形本身的空白处仍会挡住底下的点击
- 只在窗口内活动，不会在任务栏或别的窗口上爬
- 没有开机自启
- 动画是 CSS 骨骼级（呼吸/摆动/悬挂），不是逐帧序列，细节表现力有限
