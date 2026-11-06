/**
 * 桌宠窗口（Live2D 阶段一：只做窗口骨架，不含任何渲染依赖）。
 *
 * <p><b>为什么单独一个模块而不是塞进 main.cjs：</b>桌宠窗口的窗口参数（透明、置顶层级、
 * 不抢焦点、不进任务栏）与桌面主窗口完全相反，而且它还有独立的 IPC（穿透 / 拖拽 / 位置持久化）。
 * 放在 main.cjs 里会让那份文件继续膨胀，也不好单独验证。</p>
 *
 * <p><b>为什么要求「默认点击穿透」：</b>桌宠常驻在所有应用之上，如果整块窗口（含四周透明留白）
 * 都吃鼠标，用户就会在空白处「点不动」，观感极差。因此默认 `setIgnoreMouseEvents(true)`，
 * 只有命中矩形（`pet-hit-region.cjs` 从 `pet-geometry.json` 派生的可见墨迹盒）内才临时关掉穿透。</p>
 *
 * <p><b>「是否命中」由主进程独占判定（M2 重构，别再交回渲染层）：</b>判定只有一种权威——主进程
 * 自己读 `screen.getCursorScreenPoint()`，再用 `pet-hit-region.cjs` 的半开区间 + 滞回算一遍。
 * 渲染层不再有"我认为命中了"的话语权，它只做两件事：①收到 `pet:command{type:'hit-state'}`
 * 画界面；②把转发的 `mousemove` 变成一条 `pet:hover-hint` 去**叫醒**主进程
 * （载荷只有坐标，**不是判定依据**）。</p>
 *
 * <p><b>真因是端到端延迟，不是「forward 不投递」（勘误 2026-11-06）：</b>曾有一版取证声称
 * `{ forward: true }` 转发的 `mousemove` 零投递 —— 那是**假阴性**：假输入用 `SetCursorPos`
 * 只挪光标、不产生 `WM_MOUSEMOVE`，转发通道自然没东西可转；换 `SendInput` / `mouse_event`
 * 绝对坐标后转发完全正常。真正把点击吃掉的是那条链路的延迟预算：
 * `mousemove` → rAF 判定 → IPC → 主进程 30ms 合并窗口 → apply，实测"进入后立刻点"命中 1/8，
 * 等到 45ms 才 8/8 —— 落在窗口里的点击全被送给了桌面。
 * 所以现在：**回执链路里零定时器**（hint 一到就同步 apply），定频轮询降级成 16ms 安全网。</p>
 *
 * <p>历史教训（写在最显眼处）：以前这里有段注释断言「`forward: true` 是必需的，否则渲染层
 * 永远无法重新报告鼠标进来了」——**那个结论是错的**（历史勘误，别再信）：把「命中真源」
 * 托付给渲染层、又没有即时触发器，才是桌宠点击拖动全失灵的成因。`forward` 现在只是
 * `HIT_FORWARD` 常量：它决定穿透态下 hint 通道还能不能被叫醒（体验），
 * 命中正确性**不依赖它**（8ms 安全网 + 主进程自己的光标读取兜底）。</p>
 *
 * <p><b>唯一位置写入者（M3 §4.1，本文件的关键约束）：</b>本文件里**没有任何一处**直接调
 * 窗口定位 API —— 全部位置写入都收敛到 `applyPetPosition`，而它**只由** `MotionController`
 * （`pet-motion.cjs`）的私有 `applyPosition` 调用。于是"位置写入者"是结构上唯一的
 * （`gate:pet` 的 G-M1 断言本文件里按坐标设置窗口的调用出现 0 次）。本文件只提供"受控的写口"，
 * 不提供"第二条写路径"。</p>
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 桌宠 dev 端点真源（端口 / 入口页 / 身份指纹）。
 *
 * <p>"兜底入口地址"与"探活目标"必须同源：以前这里是第二处 `5174` 字面量，
 * 一旦探活脚本和服务端口对不上，`resolveDevEntryUrl` 的兜底会把窗口指向**主应用**。</p>
 */
const PET_DEV_ENDPOINT = require('./pet-dev-endpoint.cjs');

/**
 * 菜单 spec 构建器（**文案与结构的唯一真源**，零 Electron 依赖）。
 *
 * <p>右键菜单的模板从这里出：本文件不再写任何 `label` 字面量（G-M9）。它与托盘菜单共用
 * 同一份 `buildToggleItems`，所以"两处菜单同源"是事实上成立的，不是靠两处手抄得像。</p>
 */
const petMenu = require('./pet-menu.cjs');

/**
 * 偏好纯模块（schema / 降级 / 探针，零 Electron 依赖）。
 *
 * <p>这里只用它两件东西：①`defaultPrefs()`——未注入偏好端口时的兜底快照；
 * ②`detectReducedMotion()`——运行期"用户要求减少动态就拒绝开启自主运动"的判据
 * （与 U-M4 的默认值口径共用**同一个**探针，不另写一份）。</p>
 */
const petPrefs = require('./pet-prefs.cjs');

/**
 * 命中区域（纯几何 + 滞回）与命中轮询器（注入时钟）。
 *
 * <p>两者都不 `require('electron')`，所以能在纯 node 里逐值断言——这是"命中归主进程"之后
 * 唯一还能被单测覆盖的那部分逻辑，必须保持纯净。</p>
 */
const { deriveHitRect, toScreenRect, resolveInside } = require('./pet-hit-region.cjs');
const { createHitPoller } = require('./pet-hit-poller.cjs');

/** 运动模块的懒加载缓存（`null` = 还没装载过）。 */
let motionApiCache = null;

/**
 * 运动控制器模块（`pet-motion.cjs`）的**延迟 + 条件**装载（H6 / G-M11）。
 *
 * <p><b>为什么不在文件顶层 require：</b>与 `pet-geometry.json` 同构的打包不变式——主进程对
 * `./pet-window.cjs` 的 require 本来就是条件式的（只有桌宠开闸/开发态才装载），所以
 * "打包版里这段代码根本不会执行"。这里再收一道：**只有真正要建窗口时才装载运动模块**，
 * 于是"门禁关闭 ⇒ 运动模块连加载都不发生"是结构事实，而不是注释里的承诺。</p>
 *
 * @returns {object} 运动模块（`MOTION` / `MotionController` / 纯函数）
 */
function motionApi() {
  if (motionApiCache === null) {
    motionApiCache = require('./pet-motion.cjs');
  }
  return motionApiCache;
}

/**
 * 延迟取 electron 运行时。
 *
 * <p>本模块里只有创建窗口与查询屏幕才真正需要 electron；把 require 提到顶层会让这个文件
 * 在纯 node 下（单元测试）直接崩掉，而其中的坐标换算函数是纯函数，最值得被测。</p>
 */
function electron() {
  return require('electron');
}

// ---------------------------------------------------------------- 常量

/**
 * 桌宠几何真源。
 *
 * <p><b>为什么主进程也读同一份 JSON：</b>窗口尺寸以前是这里的 4 个字面量，`pet.css` 里再抄一份
 * 同名变量，靠注释互相指认——注释不会在 CI 里失败。真源收敛到 `frontend/pet-geometry.json`，
 * 主进程、渲染层（`src/pet/layout.ts`）、门禁脚本三方共读，`npm run gate:pet` 兜底。</p>
 *
 * <p><b>打包须知（U3 的事实版，别再按老注释瞎信）</b>：`package.json` 的 `build.files` 现在只有
 * 三项——`dist` 全量（含子目录）、`electron` 全量、`package.json`，**不含**这个 JSON；
 * 而本文件在 `electron/` 里，一旦被加载就会 `require('../pet-geometry.json')`。
 * 目前不崩的唯一原因：`electron/main.cjs` 对 `./pet-window.cjs` 的 require 是**条件**的
 * （只有桌宠开闸/开发态才 require），打包版桌宠恒关 ⇒ 这个 require 根本不会执行。
 * 所以：①**不许**把那个 require 改成顶层裸 require（`check-pet-hit-ownership.mjs` 有断言守着）；
 * ②哪天要在打包版开启桌宠，必须同批把这个 JSON 加进 `build.files`。</p>
 */
const GEOMETRY = require('../pet-geometry.json');

/**
 * 立绘箱宽度（CSS px）。
 *
 * <p>v2 立绘是 1024×1536 的**正立**图，立绘箱按画布 2:3 比例定、渲染等比 `contain`——
 * 箱子比例等于画布比例，才既不裁尾巴也不留横白。</p>
 */
const ART_WIDTH = GEOMETRY.artWidth;
/** 立绘箱高度（CSS px）。 */
const ART_HEIGHT = GEOMETRY.artHeight;
/**
 * 立绘四周留给「光晕 / 投影」的透明余量（兼容保留）。
 *
 * <p>M3 起真正的边距是四边 `effectMargin`（见下），`glowPad` 只在**老版本真源缺少
 * `effectMargin` 时**作为四边的回退值，保证双仓共用同一份 JSON 时不会因字段新增而炸。
 * `pet.css` 的首帧兜底仍引用它（`--pet-art-glow-pad`），所以这里不能删。</p>
 */
const GLOW_PAD = GEOMETRY.glowPad;
/**
 * 四边特效边距（上/右/下/左，CSS px）。
 *
 * <p>为什么不再用单值：<b>四类溢出方向本来就不对称</b>——呆毛弹动向上、光晕/接地阴影向下、
 * 气泡只占顶部、左右只需给耳根一点位移余量。单值只能取最大值，等于为了底部多花顶部空间。
 * M3 先做等值迁移（四边 16，窗口 188×338）；M4 拿到视觉批准后定为 24/20/18/20，
 * 窗口变成 `196×348`，立绘箱仍是 156×234（宠物本体没变大，只是留白变对了）。
 * M2 的 D-01 再改左右为 24/56/18/56 ⇒ 窗口 `268×348`：pose 批次的墨迹比立绘宽，
 * `run` 在 20px 边距下左右都要越界（详见 `pet-geometry.json` 与设计 §C1）。</p>
 */
const EFFECT_MARGIN = GEOMETRY.effectMargin ?? { top: GLOW_PAD, right: GLOW_PAD, bottom: GLOW_PAD, left: GLOW_PAD };
/**
 * 顶部为「一句话气泡」预留的高度。
 *
 * <p>预留而不是动态撑高窗口：气泡出现时改窗口尺寸会让已经拖动过的位置跳一下。</p>
 */
const BUBBLE_H = GEOMETRY.bubbleHeight;

/**
 * 桌宠窗口尺寸 = 立绘箱 + 四边特效边距 + 顶部气泡预留（**含留白**）。
 *
 * <p>四边必须分开加：一旦边距不对称，`GLOW_PAD × 2` 会让窗口比立绘箱窄，
 * 等比 `contain` 立刻被窗口边缘裁掉（尾巴最先遭殃）。`gate:pet` 会核对这两条表达式形态。</p>
 */
const PET_WIDTH = ART_WIDTH + EFFECT_MARGIN.left + EFFECT_MARGIN.right;
const PET_HEIGHT = ART_HEIGHT + EFFECT_MARGIN.top + EFFECT_MARGIN.bottom + BUBBLE_H;

/**
 * 立绘箱左上角在窗口里的位置（CSS px）。
 *
 * <p>它就是"视觉原点"：宠物在屏幕上看起来在哪儿，只由 `窗口左上角 + 这个偏移` 决定。
 * 特效边距一改（M4：上 16→24、左 16→20），窗口也要跟着变宽变高——
 * 如果只改尺寸不补位置，用户升级后会发现桌宠**凭空跳了 4px 左、8px 上**。</p>
 */
const ART_ORIGIN = { x: EFFECT_MARGIN.left, y: EFFECT_MARGIN.top + BUBBLE_H };

/**
 * 旧版（M4 之前，四边边距都是 `glowPad`）的立绘箱原点。
 *
 * <p>只用于**老状态文件补位**：那些文件里存的是旧窗口的左上角，没有记录当时的原点，
 * 于是按这份历史值反算偏移，把立绘拉回原来的屏幕位置（`x - 4`、`y - 8`）。</p>
 */
const LEGACY_ART_ORIGIN = { x: GLOW_PAD, y: GLOW_PAD + BUBBLE_H };

/** 尺寸的安全区间：太小装不下模型，太大会挡住桌面操作。 */
const MIN_DIMENSION = 120;
const MAX_DIMENSION = 1200;
/** 距离工作区边缘的默认留白（首次启动摆在右下角）。 */
const EDGE_MARGIN = 24;
/** 位置持久化文件名（落在 `app.getPath('userData')` 下）。 */
const STATE_FILE_NAME = 'pet-window-state.json';
/**
 * 置顶层级。
 *
 * <p>`screen-saver` 是 Electron 里可用到的最高层级，能盖住全屏应用之外的一切窗口；
 * 默认的 `floating` 会被某些全屏/置顶应用压住，桌宠「消失」却查不出原因。</p>
 */
const ALWAYS_ON_TOP_LEVEL = 'screen-saver';
/**
 * 命中轮询间隔（毫秒，单档 62.5 Hz = 一个显示帧）——**安全网，不是主通道**。
 *
 * <p>主通道是 `pet:hover-hint`：渲染层一收到转发的 `mousemove` 就叫醒主进程，主进程当场读
 * 光标并同步 apply，端到端只有一次 IPC 往返（1~5ms）。轮询负责主通道覆盖不到的事：
 * ①没有 mousemove 的进出（窗口被遮挡、光标从窗外绕进、切屏回来）；
 * ②转发 / hint 通道在某台机器上彻底不工作时的兜底（C13 专门验这一条）。</p>
 *
 * <p><b>为什么是 16（产品裁定：延迟不作为优化目标）：</b>产品负责人明确「立刻点那几十毫秒
 * 不用考虑」，于是按"一帧一次"定档——16ms 小于人眼可分辨的手型出现延迟，同时把空转频率
 * 压到 62.5Hz。滞回 6px 与三个例外照旧。**不追求 0ms 档命中**，所以不必为了 8ms/4ms 付 CPU（16ms 已足）。</p>
 *
 * <p>成本量级（三条控制缺一不可）：①每拍只读一次 `screen.getCursorScreenPoint()`
 * （≈62 次/秒的系统调用，无窗口事件、无 IPC）；②窗口几何**缓存**在 `poller.bounds`，
 * 采样时只做整数加减与四次比较，不做 `getBounds()` 之外的分配；③隐藏/销毁/强制态
 * **一律停表或跳过采样**（`setSuspended('hidden')`、`forcedReasons`）⇒ 桌宠不可见时
 * 采样次数为 0、CPU 归零。实测量级：62 次/秒的 `GetCursorPos` 在 Windows 上是微秒级，
 * 折算远低于 0.1% 单核占用。</p>
 */
const HIT_POLL_INTERVAL_MS = 16;
/**
 * 离开方向滞回（像素）：已在内侧时边界外扩这么多才算"离开"。
 *
 * <p>只作用于"离开"方向：进入必须准（贴着可见墨迹就算命中），离开必须钝（±1px 抖动不许翻转）。
 * 两方向都扩 ⇒ 点空气也算命中；都不扩 ⇒ 边界抖动即闪。</p>
 */
const HIT_HYSTERESIS_PX = 6;
/**
 * 穿透态是否带 `{ forward: true }`。
 *
 * <p><b>它现在有明确用处，但仍不是正确性前提。</b>穿透态下窗口收不到点击，却能收到
 * `{ forward: true }` 转发的 `mousemove` —— 渲染层把每一次转发变成 `pet:hover-hint`，
 * 于是"光标刚进立绘"那一刻就能叫醒主进程（首击能不能中全靠这条）。
 * 它**不参与判定**：主进程收到 hint 后仍然自己读光标、自己算矩形。
 * 若某台机器上它制造抖动，改成 `false` 只退化体验（剩 16ms 安全网），不需要改结构。</p>
 */
const HIT_FORWARD = true;
/** 拖拽过程中位置落盘的节流间隔（毫秒）：每帧写盘既慢又伤盘。 */
const SAVE_THROTTLE_MS = 400;
/**
 * 恢复位置时要求窗口至少有这么大比例落在某块屏幕内。
 *
 * <p>用「比例」而不是「坐标在某个 workArea 内」，是因为用户可能把窗口拖到两块屏的接缝处；
 * 只要还有相当一部分可见就算合法，完全不可见（屏幕被拔掉 / 分辨率变小）才回默认角落。</p>
 */
const MIN_VISIBLE_RATIO = 0.4;

// ---------------------------------------------------------------- 纯函数（可单测）

/**
 * 归一化一个尺寸值。
 *
 * @param value 任意输入
 * @param fallback 非法或缺失时的兜底值
 * @returns 落在 [MIN_DIMENSION, MAX_DIMENSION] 内的整数
 */
function normalizeDimension(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, num)));
}

/**
 * 计算两个矩形的相交面积。
 *
 * @param a 矩形 { x, y, width, height }
 * @param b 矩形 { x, y, width, height }
 * @returns 相交面积；不相交时为 0
 */
function intersectArea(a, b) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * 把矩形夹进某块工作区。
 *
 * @param rect 目标矩形
 * @param area 工作区 { x, y, width, height }
 * @returns 完全落在工作区内的新矩形（尺寸不变；工作区比窗口还小时贴左上角）
 */
function clampRectToWorkArea(rect, area) {
  const maxX = area.x + area.width - rect.width;
  const maxY = area.y + area.height - rect.height;
  return {
    x: Math.round(Math.min(Math.max(rect.x, area.x), Math.max(area.x, maxX))),
    y: Math.round(Math.min(Math.max(rect.y, area.y), Math.max(area.y, maxY))),
    width: rect.width,
    height: rect.height,
  };
}

/**
 * 默认落点：工作区右下角内缩 EDGE_MARGIN。
 *
 * @param size 窗口尺寸
 * @param area 工作区
 * @returns 矩形
 */
function defaultRect(size, area) {
  return {
    x: Math.round(area.x + area.width - size.width - EDGE_MARGIN),
    y: Math.round(area.y + area.height - size.height - EDGE_MARGIN),
    width: size.width,
    height: size.height,
  };
}

/**
 * 在屏幕列表里挑出与矩形重叠最多的那块屏。
 *
 * @param rect 矩形
 * @param displays 显示器信息数组
 * @returns 命中的显示器与可见比例（都不命中时为 null 与 0）
 */
function pickDisplay(rect, displays) {
  let matched = null;
  let bestArea = 0;
  const totalArea = Math.max(1, rect.width * rect.height);
  const list = Array.isArray(displays) ? displays : [];
  for (const display of list) {
    if (!display || !display.workArea) continue;
    const area = intersectArea(rect, display.workArea);
    if (area > bestArea) {
      bestArea = area;
      matched = display;
    }
  }
  return { display: matched, visibleRatio: bestArea / totalArea };
}

/**
 * 启动时的"跨版本布局迁移"：把存档里的窗口左上角换算成**当前布局**下的等价位置。
 *
 * <p><b>只做 artOrigin 补偿，别的什么都不做</b>（不判可见性、不夹取、不决定默认落点）。
 * 这条边界是本模块头号历史 bug 的分界线：</p>
 *
 * <ul>
 *   <li>用户记住的是"桌宠看起来在屏幕哪块"，不是"窗口左上角在哪"。特效边距一变
 *       （D-01：左右 20 → 56），窗口左上角就得反向挪同样的量，否则升级后宠物凭空跳位。
 *       新状态文件带 `artOrigin`；老文件没有，按 {@link LEGACY_ART_ORIGIN} 反算一次。</li>
 *   <li><b>反例（必须记）</b>：`reclampIntoDisplays` 曾经把"实时 bounds"喂给这个函数当存档，
 *       于是每次显示器事件都被当成"老存档"补偿一次 `(16−56, 88−96) = (−40, −8)`，
 *       插拔显示器/改分辨率时桌宠向左上累积漂移（QA D-02，5 次事件 −200/−40）。
 *       实时 bounds 的立绘原点**就是**当前 `ART_ORIGIN`，补偿量理应为 0——
 *       所以"夹回可见区"必须走 {@link clampIntoWorkArea}，不是这里。</li>
 * </ul>
 *
 * @param saved 上次持久化的状态（可为 null；只读 `x` / `y` / `artOrigin`）
 * @param size 目标尺寸 { width, height }
 * @returns 迁移后的矩形；存档里没有可用坐标时返回 `null`（由调用方决定默认落点）
 */
function migrateSavedBounds(saved, size) {
  const width = normalizeDimension(size && size.width, PET_WIDTH);
  const height = normalizeDimension(size && size.height, PET_HEIGHT);
  const savedX = saved ? Number(saved.x) : Number.NaN;
  const savedY = saved ? Number(saved.y) : Number.NaN;
  if (!Number.isFinite(savedX) || !Number.isFinite(savedY)) return null;
  const savedOrigin =
    saved && saved.artOrigin && Number.isFinite(Number(saved.artOrigin.x)) && Number.isFinite(Number(saved.artOrigin.y))
      ? { x: Number(saved.artOrigin.x), y: Number(saved.artOrigin.y) }
      : LEGACY_ART_ORIGIN;
  return {
    x: Math.round(savedX + (savedOrigin.x - ART_ORIGIN.x)),
    y: Math.round(savedY + (savedOrigin.y - ART_ORIGIN.y)),
    width,
    height,
  };
}

/**
 * 纯夹取：把一个矩形**只**拉回某块工作区内（零补偿、零跨版本语义）。
 *
 * <p>调用方两处：启动解算（先 {@link migrateSavedBounds} 再夹）与显示器变化后的
 * `reclampIntoDisplays`（只夹、不迁移）。两个职责分开之后，"传错参数就漂移"这条
 * 事故路径在结构上不存在了——`reclamp` 里根本没有补偿可误用。</p>
 *
 * <p>判据与启动路径一致：可见面积占比低于 {@link MIN_VISIBLE_RATIO}（屏幕真的没了）
 * 才回默认角落，否则夹到该屏工作区内。</p>
 *
 * @param rect 待夹取的矩形（宽度/高度非法时取窗口默认值）
 * @param displays 显示器信息数组（来自 `screen.getAllDisplays()`）
 * @param primaryArea 主显示器工作区（兜底落点用）
 * @returns 完全落在某块工作区内的矩形
 */
function clampIntoWorkArea(rect, displays, primaryArea) {
  const width = normalizeDimension(rect && rect.width, PET_WIDTH);
  const height = normalizeDimension(rect && rect.height, PET_HEIGHT);
  const wanted = { width, height };
  const x = rect ? Number(rect.x) : Number.NaN;
  const y = rect ? Number(rect.y) : Number.NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return defaultRect(wanted, primaryArea);
  }
  const candidate = { x: Math.round(x), y: Math.round(y), width, height };
  const { display, visibleRatio } = pickDisplay(candidate, displays);
  if (!display || visibleRatio < MIN_VISIBLE_RATIO) {
    return defaultRect(wanted, primaryArea);
  }
  return clampRectToWorkArea(candidate, display.workArea);
}

/**
 * 解算桌宠窗口的启动位置（**只给"启动读存档"用**：迁移 + 夹取两步的组合）。
 *
 * <p>三种情况：没存过 / 存的是脏数据 → 默认角落；存过但已经越界（屏幕被拔掉、分辨率变小）
 * → 默认角落；仍在某块屏上有足够可见面积 → 夹进那块屏。**永远返回一个完全可见的位置**，
 * 因为一个跑到屏幕外的桌宠用户没法用鼠标找回来（它还不进任务栏）。</p>
 *
 * <p>运行时（窗口已存在、位置已生效）**不许**调它——那条路径用 {@link clampIntoWorkArea}，
 * 否则实时 bounds 会被当成老存档再补偿一次（D-02）。</p>
 *
 * @param options.saved 上次持久化的状态（可为 null）
 * @param options.size 目标尺寸 { width, height }
 * @param options.displays 显示器信息数组（来自 `screen.getAllDisplays()`）
 * @param options.primaryArea 主显示器工作区（兜底落点用）
 * @returns 完全落在某块工作区内的矩形
 */
function resolveInitialBounds({ saved, size, displays, primaryArea }) {
  const migrated = migrateSavedBounds(saved, size);
  if (migrated === null) {
    return defaultRect(
      {
        width: normalizeDimension(size && size.width, PET_WIDTH),
        height: normalizeDimension(size && size.height, PET_HEIGHT),
      },
      primaryArea,
    );
  }
  return clampIntoWorkArea(migrated, displays, primaryArea);
}

// ---------------------------------------------------------------- 状态文件

/**
 * 读取持久化的窗口状态。
 *
 * @param filePath 状态文件绝对路径
 * @returns 解析成功的对象，任何异常都返回 null（位置读不出来就回默认角落，不能阻塞启动）
 */
function readState(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 写入窗口状态。
 *
 * @param filePath 状态文件绝对路径
 * @param state 待写入的对象
 * @returns 是否写入成功（失败只记日志：位置存不下不影响本次使用）
 */
function writeState(filePath, state) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn(`[pet] 位置保存失败: path=${filePath}, error=${(err && err.message) || err}`);
    return false;
  }
}

// ---------------------------------------------------------------- 窗口管理器

/**
 * 注册桌宠窗口。
 *
 * @param options.ipcMain Electron 的 ipcMain
 * @param options.isDev 是否开发态（决定入口走 Vite 服务还是 dist 产物）
 * @param options.frontendRoot 前端根目录（解析 `dist/pet.html`）
 * @param options.statePath 可选：状态文件路径覆盖（测试用）
 * @param options.clock 可选：时钟（默认全局；测试注入手动时钟，命中轮询才可确定性推进）
 * @returns 窗口管理 API
 */
/**
 * 开发态入口兜底地址。
 *
 * <p><b>为什么从单一真源取：</b>以前这里是 `http://localhost:5174` 字面量——5174 是
 * <b>主应用</b>的 dev server 端口，于是"兜底"变成"兜到主应用界面"。端口、宿主、入口页
 * 现在只有 `electron/pet-dev-endpoint.cjs` 一处真源，`ELECTRON_URL` 脏值时退化到它。</p>
 */
const DEV_ENTRY_FALLBACK = PET_DEV_ENDPOINT.buildDevOrigin();

/**
 * 桌宠入口页文件名（`pet.html`）。
 *
 * <p><b>为什么不是字面量（K4）：</b>入口页名以前在 `resolveEntry()` 里写了两遍——
 * dev 分支 `${url}pet.html`、dist 分支 `path.join(root,'dist','pet.html')`。
 * 而探活侧（`electron/pet-dev-probe.cjs`）用的是真源里的 `entryPage`：
 * <b>一处改名就变成"探活这个页面、窗口加载那个页面"</b>，与当初"探活指向主应用、
 * 窗口指向别处"是同一类缺陷。所以只认 `electron/pet-dev-endpoint.cjs` 的
 * `DEV_ENDPOINT.entryPage`，dev / dist 两条分支共用它。</p>
 */
const PET_ENTRY_PAGE = PET_DEV_ENDPOINT.DEV_ENDPOINT.entryPage;

/**
 * 把 `ELECTRON_URL` 规整成一个可安全拼接的 base URL（恒以 `/` 结尾）。
 *
 * <p><b>为什么需要这层（真实事故）：</b>这个环境变量由批处理脚本设置，而
 * `set VAR=value &amp;&amp; cmd` 会把 value 后面那个空格一起设进去。旧实现是
 * `${url}/` 先拼字符串再 `new URL()`——空格落在主机名里变成 `5174 /`，
 * URL 解析器再怎么容错也救不回来，直接抛 `Invalid URL`，主进程弹
 * 「A JavaScript error occurred in the main process」。
 *
 * <p>所以顺序必须是：**先解析校验，再拼路径**。入口地址是可降级配置，
 * 脏值只该退化成默认端口加一条告警，绝不该阻断启动。</p>
 *
 * @param raw 环境变量原值（不可信：可能为空、带空格、带引号、根本不是 URL）
 * @returns 规范化后的 base URL，恒以 `/` 结尾
 */
function resolveDevEntryUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
  if (!value) return `${DEV_ENTRY_FALLBACK}/`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    console.warn(`[pet] ELECTRON_URL 不是合法 URL（原值=${JSON.stringify(raw)}），已回退到 ${DEV_ENTRY_FALLBACK}`);
    return `${DEV_ENTRY_FALLBACK}/`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn(`[pet] ELECTRON_URL 协议不受支持（${parsed.protocol}），已回退到 ${DEV_ENTRY_FALLBACK}`);
    return `${DEV_ENTRY_FALLBACK}/`;
  }
  const href = parsed.toString();
  return href.endsWith('/') ? href : `${href}/`;
}

/**
 * 计算桌宠窗口的入口（纯函数，不需要 Electron，便于单测）。
 *
 * <p>两条分支共用同一个入口页名 {@link PET_ENTRY_PAGE}（来自单一真源）：</p>
 * <ul>
 *   <li>开发态：`ELECTRON_URL` 规整后 + 入口页名，走 Vite 服务；</li>
 *   <li>打包态：`&lt;frontendRoot&gt;/dist/` + 入口页名，走本地文件。</li>
 * </ul>
 *
 * <p><b>为什么抽成纯函数（K4 副产物）：</b>原来这段逻辑埋在 `registerPetWindow` 的闭包里，
 * 要测"入口页到底用了哪个名字"必须起 Electron。抽出来以后可以只喂参数就断言两条分支
 * 都等于真源里的 `entryPage`，改名/硬编码会立刻被发现。</p>
 *
 * @param options 入参
 * @param options.isDev 是否开发态
 * @param options.frontendRoot 前端根目录（打包态解析 `dist/`）
 * @param options.rawUrl `ELECTRON_URL` 原值（未可信：可能为空/带空格/带引号）
 * @returns {{kind: 'url' | 'file', value: string}} 入口描述
 * @throws {TypeError} 打包态未提供合法 `frontendRoot` 时抛出
 */
function resolveEntrySpec({ isDev, frontendRoot, rawUrl }) {
  if (isDev === true) {
    return { kind: 'url', value: `${resolveDevEntryUrl(rawUrl)}${PET_ENTRY_PAGE}` };
  }
  if (typeof frontendRoot !== 'string' || frontendRoot.trim() === '') {
    throw new TypeError('resolveEntrySpec：打包态必须提供非空的 frontendRoot');
  }
  return { kind: 'file', value: path.join(frontendRoot, 'dist', PET_ENTRY_PAGE) };
}

/**
 * 兜底偏好快照（未注入端口时）。
 *
 * @returns {{version: number, follow: boolean, roam: boolean}} 偏好
 */
function fallbackPrefs() {
  const defaults = petPrefs.defaultPrefs();
  return { version: defaults.version, follow: defaults.follow === true, roam: defaults.roam !== false };
}

/**
 * 归一偏好端口（**注入式**：`main.cjs` 传 `petPrefsPort`，测试传内存桩）。
 *
 * <p>为什么必须有兜底端口：`registerPetWindow` 也被纯窗口用例直接调用（只关心位置与命中），
 * 那些用例不该被迫构造一个偏好仓库。兜底端口的行为是"只读默认值 + 写入一律不受理"，
 * 而且**不触盘**——与"门禁关闭"时 main.cjs 传 `store:null` 的语义一致。</p>
 *
 * @param {object|null} port 注入的端口（`{getPrefs, setPrefs, onPrefsChange}`）
 * @returns {{getPrefs: Function, setPrefs: Function, onPrefsChange: Function}} 归一后的端口
 */
function normalizePrefsPort(port) {
  if (
    port &&
    typeof port === 'object' &&
    typeof port.getPrefs === 'function' &&
    typeof port.setPrefs === 'function'
  ) {
    return {
      getPrefs: () => {
        const current = port.getPrefs();
        const snapshot = current && typeof current === 'object' ? current : fallbackPrefs();
        return {
          version: Number.isFinite(snapshot.version) ? Number(snapshot.version) : 1,
          follow: snapshot.follow === true,
          roam: snapshot.roam !== false,
        };
      },
      setPrefs: (patch) => {
        const result = port.setPrefs(patch);
        if (result && typeof result === 'object') return result;
        return { prefs: fallbackPrefs(), ok: false, problems: [], changed: false };
      },
      onPrefsChange: (listener) =>
        typeof port.onPrefsChange === 'function' ? port.onPrefsChange(listener) : () => {},
    };
  }
  return {
    getPrefs: () => fallbackPrefs(),
    setPrefs: () => ({ prefs: fallbackPrefs(), ok: false, problems: [], changed: false }),
    onPrefsChange: () => () => {},
  };
}

/**
 * 注册桌宠窗口（窗口参数 + IPC + 显隐与持久化 + 运动控制接线）。
 *
 * @param options 依赖注入
 * @param {object} options.ipcMain Electron 的 `ipcMain`（主进程传真实对象，测试传桩）
 * @param {boolean} options.isDev 是否开发态（决定入口 URL 还是打包文件）
 * @param {string} options.frontendRoot 前端根目录（解析入口用）
 * @param {string} [options.statePath] 位置状态文件（默认落在 userData）
 * @param {object} [options.clock] 时钟（命中轮询用；测试注入手动时钟）
 * @param {object} [options.prefs] 偏好端口 `{getPrefs, setPrefs, onPrefsChange}`（来自 `main.cjs`）
 * @param {object} [options.menu] 菜单构建器（默认就是 `pet-menu.cjs`）
 * @returns 窗口控制器
 */
function registerPetWindow({ ipcMain, isDev, frontendRoot, statePath, clock = globalThis, prefs = null, menu = null }) {
  const resolvedStatePath = statePath || path.join(electron().app.getPath('userData'), STATE_FILE_NAME);
  /** 偏好端口（右键菜单勾选态、`pet:prefs-set`、运动层的 reduced-motion 判据都读它）。 */
  const prefsPort = normalizePrefsPort(prefs);
  /** 菜单构建器：只接受"有构建能力"的注入，否则用本仓唯一真源。 */
  const menuBuilder = menu && typeof menu.buildContextMenuItems === 'function' ? menu : petMenu;
  /** 系统"减少动态"探针结果（懒求值一次；同一进程内不会变）。 */
  let reducedMotionMemo = null;

  /**
   * 命中矩形（窗口坐标，DIP）。
   *
   * <p>只在这里算一次：它只是 `pet-geometry.json` 的函数，运行期不会变。
   * 屏幕坐标版本在每次采样时用当前 `win.getBounds()` 现算（窗口会移动）。</p>
   */
  const hitRect = deriveHitRect(GEOMETRY);

  /** 当前桌宠窗口（懒创建：托盘被点之前不占任何资源）。 */
  let win = null;
  /** 当前是否处于点击穿透。初始为 true：窗口一出现就必须是穿透的。 */
  let ignoring = true;
  /** 命中轮询器（窗口存在时必有；随窗口销毁置空）。 */
  let poller = null;
  /**
   * 运动控制器（**全仓唯一会移动窗口的组件**；随窗口创建，随窗口销毁置空）。
   *
   * <p>它只在 `create()` 里建（那一刻桌宠开闸已确定），所以"门禁关闭 ⇒ 运动模块不被加载"
   * 是结构事实。窗口不存在时它必须是 `null`——所有调用点都写 `motion?.` 或先判空。</p>
   */
  let motion = null;
  /**
   * 是否正在自定义拖拽。
   *
   * <p>注意这里**没有** `lastInside`：滞回状态由轮询器自己持有并回传给 `testPoint`
   * （见 {@link createHitPollerForWindow}）。主进程这层若再存一份，两份真源早晚不同步。</p>
   */
  let dragging = false;
  /** 拖拽起点：光标相对窗口左上角的偏移，保证「抓起哪就从哪拖」。 */
  let dragOffset = { x: 0, y: 0 };
  /** 位置落盘定时器。 */
  let saveTimer = null;
  /** 可见性变化订阅者（托盘要跟着刷新勾选状态）。 */
  const visibilityListeners = new Set();
  /** 偏好变化订阅的退订函数（`null` = 还没订阅；窗口重建时不重复订阅）。 */
  let prefsUnsubscribe = null;
  /** 屏幕变化监听是否已挂（screen 只能在 app ready 之后用，故延迟到首次创建）。 */
  let displayListenersBound = false;

  /**
   * 向渲染层安全下发一条命令（renderer 可能已经崩了）。
   *
   * <p><b>为什么不能只判 `win.isDestroyed()`：</b>renderer 崩溃时窗口只是被 `hide()`（不 destroy），
   * `win.isDestroyed()` 仍是 `false`，但 webContents 的 render frame 已经 disposed，
   * `send` 会抛 `Render frame was disposed before WebFrameMain could be accessed`。
   * Electron 会把这个错误打进日志（主进程不崩），但**未捕获异常路径不该靠 Electron 兜**：
   * 一次崩溃会刷两三条同样的噪声，掩盖真正的错误。</p>
   *
   * <p>四道守卫按代价从低到高：窗口存在 → 窗口未销毁 → webContents 未销毁/未崩溃 → try/catch。
   * 前三道挡住绝大多数情况，最后一道兜住"检查通过但发送瞬间失效"的竞态。</p>
   *
   * <p><b>守卫不放宽语义：</b>渲染层不可达时消息本来就没人听，跳过它不改变任何可见行为；
   * 调用方也**不得**因为下发失败而跳过自己的后续逻辑（例如 `notifyVisibility` 里的
   * 托盘勾选回调必须照常执行）。</p>
   *
   * @param {string} channel IPC 通道
   * @param {unknown} payload 载荷
   * @returns {boolean} 是否真的下发（false = 渲染层不可达，已安全跳过）
   */
  function safeSend(channel, payload) {
    if (!win || win.isDestroyed()) return false;
    const contents = win.webContents;
    if (!contents) return false;
    if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return false;
    if (typeof contents.isCrashed === 'function' && contents.isCrashed()) return false;
    try {
      contents.send(channel, payload);
      return true;
    } catch (err) {
      console.warn(
        `[pet] 渲染层已不可达，跳过下发（renderer 崩溃后 frame 已 disposed）: channel=${channel} error=${(err && err.message) || err}`,
      );
      return false;
    }
  }

  /**
   * 通知外界可见性变了。
   *
   * <p><b>两个收件人，缺一不可：</b></p>
   * <ol>
   *   <li>主进程订阅者（托盘据此刷新桌宠开关项的勾选态）——一直是这么用的；</li>
   *   <li><b>渲染层</b>（M6-b 补上）：渲染层的功耗策略里 `off` 档的判据是 `visible === false`，
   *       而在此之前**没有任何代码把可见性下发给渲染层**，于是 `off` 是一条死分支：
   *       桌宠被藏起来以后只落到 `low`（动画时长 ×2，仍在跑合成器 + 眨眼定时器照常）。
   *       分层开闸后这句话的分量变了：藏起来的桌宠原来是 2 张静止帧，现在是
   *       **9 层各跑一条 CSS 动画**，白烧的电直接翻了好几倍。</li>
   * </ol>
   *
   * <p>时序安全：窗口还没建/DOM 还没就绪时下发也没人听，加载完成后 `did-finish-load` 会再发一条
   * `ready`，渲染层以最后一条状态为准。renderer 崩溃后这次下发会被 {@link safeSend} 安全跳过，
   * 但下面那轮 `visibilityListeners` 回调**必须照常执行**（托盘勾选不能因为渲染层崩了就不刷新）。</p>
   */
  function notifyVisibility() {
    const visible = isVisible();
    safeSend('pet:command', { type: 'visible', visible });
    for (const listener of visibilityListeners) {
      try {
        listener(visible);
      } catch (err) {
        console.warn(`[pet] 可见性回调异常: error=${(err && err.message) || err}`);
      }
    }
  }

  /** 当前是否可见。 */
  function isVisible() {
    return !!win && !win.isDestroyed() && win.isVisible();
  }

  /** 取屏幕 API（app ready 之后才可用）。 */
  function screenApi() {
    return electron().screen;
  }

  /**
   * 窗口入口：开发态走 Vite 服务，打包态走 dist 内的多入口产物。
   *
   * <p>开发态 URL 一律经 {@link resolveDevEntryUrl} 规整：先解析校验再拼入口页，
   * 不要反过来（历史上就是先拼字符串、空格落进主机名，抛 `Invalid URL` 崩主进程）。</p>
   *
   * <p>两条分支的入口页名都来自单一真源（见 {@link resolveEntrySpec}），
   * 这里不再出现 `'pet.html'` 字面量：探活打哪个页面，窗口就加载哪个页面。</p>
   */
  function resolveEntry() {
    return resolveEntrySpec({ isDev, frontendRoot, rawUrl: process.env.ELECTRON_URL });
  }

  /**
   * 把「是否穿透」**同步**下发给窗口（唯一去重权威就在这个函数里）。
   *
   * <p><b>为什么不再有 30ms 合并窗口：</b>它的唯一调用方现在是 62.5 Hz 的轮询器（16ms 一档），且只在
   * 有效命中**变化**时被调用（≤ 几次/秒），天然没有"一次移动 60 次"的风暴要合并；
   * 而它带来的成本是纯粹的点击相位损失——状态已该翻转，窗口却还有最多 30ms 处于穿透态，
   * 用户点击正好落在那个相位就整个丢失。这正是缺陷报告里"点击基本没反应"的机制之一。</p>
   *
   * <p>去重只剩下面那一句 `target === ignoring`：渲染层已经没有可写的命中状态
   * （`pet:set-hit` 通道已删），所以"渲染层去重"这个竞争源被物理消灭。</p>
   *
   * @param next 目标值，true = 穿透
   */
  function applyIgnoreMouse(next) {
    const target = next === true;
    if (target === ignoring) return;
    if (!win || win.isDestroyed()) return;
    ignoring = target;
    win.setIgnoreMouseEvents(target, target && HIT_FORWARD ? { forward: true } : undefined);
    // 每次跃迁恰好一条回执：渲染层用它显示调试徽标（生产态不可见）
    // renderer 崩溃时这条会被安全跳过（窗口只是 hide，isDestroyed 仍为 false，帧已 disposed）
    safeSend('pet:command', { type: 'hit-state', hit: !target });
  }

  /**
   * 窗口位置/尺寸变化后同步给轮询器（否则屏幕矩形还停留在旧位置）。
   *
   * @returns {void}
   */
  function windowBoundsChanged() {
    const bounds = captureBounds();
    if (!bounds) return;
    poller?.setWindowBounds(bounds);
  }

  /**
   * 建命中轮询器并接线三个例外。
   *
   * <p>判定链：`resolveInside(上一拍, 屏幕坐标命中矩形, 光标, 滞回)`。矩形每次采样现算，
   * 因为窗口会移动；`lastInside` 由轮询器持有并回传（滞回必须跨采样保留）。</p>
   *
   * @returns {void}
   */
  function createHitPollerForWindow() {
    poller = createHitPoller({
      intervalMs: HIT_POLL_INTERVAL_MS,
      clock,
      getCursorPoint: () => screenApi().getCursorScreenPoint(),
      testPoint: (point, bounds, prevInside) =>
        resolveInside(prevInside, toScreenRect(bounds, hitRect), point, HIT_HYSTERESIS_PX),
      onHitChange: (hit) => applyIgnoreMouse(!hit),
    });
    poller.setWindowBounds(captureBounds());
    poller.start();
  }

  /**
   * **受控的位置写口**（本文件唯一会移动窗口的地方，且只由 `MotionController` 调）。
   *
   * <p><b>为什么用 `setBounds` 而不是按坐标设置位置的那个 API：</b>语义上等价（宽高原样带回去，
   * 尺寸不变、只有位置变），但它让"位置写入点"在全仓**只有一个**（G-M1：本文件里
   * 按坐标设置窗口的调用出现 0 次）。这样"谁在写位置"可以用一次文本搜索回答，而不是靠人读代码——
   * 单写者是结构事实，不是纪律。</p>
   *
   * <p>写完必须同步命中矩形的屏幕原点（`windowBoundsChanged`）：否则窗口动了、命中判定还停在
   * 旧坐标上，用户看到的是"猫走到别处了，但点击还认原来那块地方"。</p>
   *
   * @param {number} x 目标 X（整数 DIP）
   * @param {number} y 目标 Y（整数 DIP）
   * @returns {boolean} 是否真的写了（窗口不存在 ⇒ false）
   */
  function applyPetPosition(x, y) {
    if (!win || win.isDestroyed()) return false;
    const bounds = win.getBounds();
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height }, false);
    windowBoundsChanged();
    return true;
  }

  /**
   * 系统"减少动态"的当前值（与 U-M4 的默认值口径共用 `pet-prefs.cjs` 的同一个探针）。
   *
   * <p>它在这里的用途**只是运行期拒绝**（用户要求减少动态 ⇒ 拒绝开启自主运动），
   * 不参与"默认值覆盖"——那是接线层的事，本文件不重复判。</p>
   *
   * @returns {boolean} 是否要求减少动态
   */
  function readReducedMotion() {
    if (reducedMotionMemo !== null) return reducedMotionMemo;
    let result = { reducedMotion: false };
    try {
      const api = electron();
      result = petPrefs.detectReducedMotion({ systemPreferences: api.systemPreferences, app: api.app });
    } catch {
      // 探针拿不到 electron（纯 node 用例）：按"不做默认值覆盖"的同一口径处理
      result = { reducedMotion: false };
    }
    reducedMotionMemo = result.reducedMotion === true;
    return reducedMotionMemo;
  }

  /**
   * 运动层看到的偏好（**唯一来源是注入的偏好端口 + 探针**）。
   *
   * @returns {{follow: boolean, roam: boolean, reducedMotion: boolean}} 运动相关偏好
   */
  function readMotionPrefs() {
    const current = prefsPort.getPrefs();
    return {
      follow: current.follow === true,
      roam: current.roam !== false,
      reducedMotion: readReducedMotion(),
    };
  }

  /**
   * 建运动控制器并接线（**窗口存在时才建**，所以它天然在门禁开启路径上）。
   *
   * <p>注入的七件东西就是"运动层需要的外部能力"全集：时钟（只排漫游时间表）、光标、
   * 工作区（每拍重读）、唯一写口、偏好、下发通道、每拍订阅。运动层自己**不注册定时器**，
   * 唯一的时钟就是命中轮询器那一拍（§4.1 L1）。</p>
   *
   * @returns {void}
   */
  function createMotionForWindow() {
    const { MotionController } = motionApi();
    const bounds = captureBounds() || { x: 0, y: 0, width: PET_WIDTH, height: PET_HEIGHT };
    motion = new MotionController({
      // 唯一窗口移动出口（本函数之外没有任何地方移动窗口）
      setWindowPosition: (x, y) => applyPetPosition(x, y),
      // 唯一时钟：命中轮询器那一拍（它也负责"隐藏时停表"）
      subscribeSample: (listener) => (poller ? poller.onSample(listener) : () => {}),
      // 工作区每拍现算（跨屏 / 分辨率变化下一拍就生效，不许跨拍缓存）
      workArea: (point) => resolveWorkArea(point),
      displayId: (point) => {
        try {
          return screenApi().getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).id;
        } catch {
          return 0;
        }
      },
      size: { width: PET_WIDTH, height: PET_HEIGHT },
      artOrigin: { ...ART_ORIGIN },
      artSize: { width: ART_WIDTH, height: ART_HEIGHT },
      initial: { x: bounds.x, y: bounds.y },
      cursor: () => screenApi().getCursorScreenPoint(),
      prefs: () => readMotionPrefs(),
      send: (command) => {
        safeSend('pet:command', command);
      },
      clock: { now: () => (typeof clock.now === 'function' ? clock.now() : Date.now()) },
      // 写完之后把命中矩形的屏幕原点也刷新（applyPetPosition 里已做，这里再挂一次回调是为了
      // 让"写口"与"写后钩子"在运动层的视角里也是同一件事：onAfterWrite）
      afterWrite: () => windowBoundsChanged(),
    });
    motion.start();
  }

  /** 取窗口当前几何；窗口不存在时返回 null。 */
  function captureBounds() {
    if (!win || win.isDestroyed()) return null;
    const bounds = win.getBounds();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }

  /** 立即把当前位置写盘。 */
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const bounds = captureBounds();
    if (!bounds) return;
    writeState(resolvedStatePath, { ...bounds, artOrigin: ART_ORIGIN, updatedAt: new Date().toISOString() });
  }

  /** 拖拽期间的落盘节流。 */
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const bounds = captureBounds();
      if (!bounds) return;
      writeState(resolvedStatePath, { ...bounds, artOrigin: ART_ORIGIN, updatedAt: new Date().toISOString() });
    }, SAVE_THROTTLE_MS);
  }

  /**
   * 把窗口拉回可见区（显示器增减 / 分辨率变化后调用）。
   *
   * <p><b>这里只许夹取，不许做跨版本迁移</b>（QA D-02）：实时 bounds 的立绘原点就是当前
   * `ART_ORIGIN`，补偿量恒为 0；一旦误用 {@link resolveInitialBounds}，每次显示器事件都会
   * 按 `LEGACY_ART_ORIGIN` 补偿 `(−40, −8)` 并累积（实测 5 次 −200/−40）。</p>
   *
   * <p>夹完必须 `flushSave()`：否则下次启动仍读旧位置，等于这次夹取白做（用户看到的是
   * "位置这次对了、重启又跑偏"）。位置没变时也落盘——顺手把缺 `artOrigin` 的老状态
   * 文件补正，杜绝"每次启动都补一次偏移"。</p>
   */
  function reclampIntoDisplays() {
    // 拖拽期间不许抢写：位置写入权在手指那边（`dragTo` 持有 `drag` 令牌）。
    // 显示器事件（拔屏 / 混合 DPI 下把桌宠拖过屏界 / 分辨率变化）会在拖拽中触发，
    // 若这里也写一次，下一帧 `dragTo` 再用旧 offset 拽回去 ⇒ 窗口在手指下往返跳
    // （真机实测 500→0→500）。松手后的 `endDrag` 会照常处理边界，不必在这里抢。
    if (dragging) return;
    const bounds = captureBounds();
    if (!bounds) return;
    const { screen } = electron();
    const target = clampIntoWorkArea(bounds, screen.getAllDisplays(), screen.getPrimaryDisplay().workArea);
    const moved = target.x !== bounds.x || target.y !== bounds.y;
    if (moved && motion) {
      // 位置写入权交给运动层（**唯一写点**）：它按同一份 clampIntoWorkArea 的结果落位，
      // 顺带把它自己的浮点累加器对齐（否则下一拍会朝旧位置走）。
      motion.reclampNow(target);
    }
    flushSave();
    // 位置变了 ⇒ 命中矩形的屏幕平移量也要跟着变（否则"夹回可见区"之后命中判在旧坐标上）
    windowBoundsChanged();
  }

  /** 挂显示器变化监听：屏幕被拔掉时桌宠不能留在看不见的地方。 */
  function bindDisplayListeners() {
    if (displayListenersBound) return;
    displayListenersBound = true;
    try {
      const { screen } = electron();
      screen.on('display-removed', reclampIntoDisplays);
      screen.on('display-metrics-changed', reclampIntoDisplays);
    } catch (err) {
      console.warn(`[pet] 显示器监听注册失败: error=${(err && err.message) || err}`);
    }
  }

  /** 校验 IPC 来源：只认桌宠窗口自己。 */
  function isFromPet(event) {
    return !!win && !win.isDestroyed() && event.sender === win.webContents;
  }

  /** 取某个屏幕坐标所在显示器的工作区。 */
  function resolveWorkArea(point) {
    const { screen } = electron();
    const x = Number.isFinite(point && point.x) ? point.x : 0;
    const y = Number.isFinite(point && point.y) ? point.y : 0;
    return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
  }

  /** 关闭并销毁窗口（退出时用）。 */
  function destroy() {
    // 先停运动（它还握着一份订阅），再停轮询器：顺序反了会在"订阅者还在、定时器已停"的
    // 中间态里调 poll()，虽然无害但没必要留这个窗口期。
    motion?.stop();
    motion = null;
    poller?.stop();
    poller = null;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    dragging = false;
    if (win && !win.isDestroyed()) {
      // close 事件里会落盘最后一次位置
      win.destroy();
    }
    win = null;
  }

  /**
   * 隐藏窗口（保留实例，位置与渲染状态都在）。
   *
   * <p>顺序要紧：**先把穿透置回 true，再藏窗口**。否则下一次显示时窗口可能还停在
   * "可交互"，用户看到一个整块吃鼠标的透明窗口（而且那时光标根本没在上面）。
   * 这里交给轮询器做（`setSuspended` 内部先收敛到"未命中"再停表），
   * 这样"谁决定穿透"仍然只有轮询器一个权威，不会出现"hide 里改了、poller 还以为是旧值"。</p>
   */
  function hide() {
    if (!win || win.isDestroyed()) return;
    flushSave();
    poller?.setSuspended('hidden', true);
    // 运动层也要停表：窗口藏起来之后"猫在哪儿"没有任何意义，0 采样 0 写入（§8.3）
    motion?.setSuspended('hidden', true);
    win.hide();
    notifyVisibility();
  }

  /**
   * 创建（或复用）桌宠窗口。
   *
   * @returns BrowserWindow 实例
   */
  function create() {
    if (win && !win.isDestroyed()) return win;
    const { BrowserWindow, screen } = electron();
    bindDisplayListeners();

    const size = { width: PET_WIDTH, height: PET_HEIGHT };
    const initial = resolveInitialBounds({
      saved: readState(resolvedStatePath),
      size,
      displays: screen.getAllDisplays(),
      primaryArea: screen.getPrimaryDisplay().workArea,
    });
    // 迁移结果立刻落盘（带 artOrigin）：老状态文件缺 artOrigin 时，上面按 LEGACY_ART_ORIGIN
    // 补偿了一次；不写回去的话**每次启动都会再补一次**，等于把单次迁移变成持续漂移。
    // 这里写的是"接下来窗口真实所在的位置 + 当前立绘原点"，所以第二次启动的补偿量恒为 0。
    writeState(resolvedStatePath, {
      x: initial.x,
      y: initial.y,
      width: initial.width,
      height: initial.height,
      artOrigin: ART_ORIGIN,
      updatedAt: new Date().toISOString(),
    });

    const entry = resolveEntry();
    win = new BrowserWindow({
      x: initial.x,
      y: initial.y,
      width: initial.width,
      height: initial.height,
      // 一律透明无边框：留白必须真透，否则桌面上会多一块灰色方块
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      // 桌宠的位置只由我们的拖拽逻辑决定，不让窗口管理器参与
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // 不进任务栏：桌宠不是「应用窗口」，alt-tab 里也不该出现
      skipTaskbar: true,
      alwaysOnTop: true,
      // 不抢焦点：用户正在别的应用里打字，点一下桌宠不该把光标夺走
      focusable: false,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'pet-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        // 与其它窗口保持一致：preload 需要 node 能力（读 ipcRenderer），渲染层本身仍是隔离的
        sandbox: false,
        // 桌宠永远在最前面，被判定「后台」后动画会掉帧；这里显式关掉节流
        backgroundThrottling: false,
      },
    });

    // 置顶层级要显式给：默认 floating 会被某些置顶应用压住
    win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
    // 一出现就是穿透的：空白区域绝不吃鼠标（forward 是可选输入，见 HIT_FORWARD）
    win.setIgnoreMouseEvents(true, HIT_FORWARD ? { forward: true } : undefined);
    ignoring = true;
    // 命中归主进程：起轮询器（这一刻起"鼠标在不在宠物身上"不再需要任何窗口事件）
    createHitPollerForWindow();
    // 运动控制：订阅**上面那个**轮询器的每一拍（不新起定时器），并独占位置写入权
    createMotionForWindow();
    // 偏好变化 → ①广播给渲染层（`pet:command{type:'prefs'}`）②收回不允许的运动
    if (prefsUnsubscribe === null) {
      prefsUnsubscribe = prefsPort.onPrefsChange((next) => {
        const snapshot = {
          follow: next && next.follow === true,
          roam: next && next.roam !== false,
        };
        // 两种写法都给：渲染层读扁平字段（`main.ts` 的 `locomotion.onPrefs(follow, roam)`），
        // 设计 §8.2 的载荷形状是 `{follow, roam}`；嵌套的 `prefs` 供 CDP/排障直接看结构。
        safeSend('pet:command', { type: 'prefs', follow: snapshot.follow, roam: snapshot.roam, prefs: snapshot });
        const stopped = motion ? motion.applyPrefs({ ...snapshot, reducedMotion: readReducedMotion() }) : false;
        if (stopped) poller?.poll();
      });
    }

    // 桌宠窗口不该导航、不该开新窗（内容里将来可能混入模型资源）
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });

    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      // showInactive：桌宠永远不该抢焦点
      win.showInactive();
      notifyVisibility();
    });

    win.webContents.once('did-finish-load', () => {
      if (!win || win.isDestroyed()) return;
      // renderer 若在加载完成后立刻崩掉，这条 ready 会被 safeSend 安全跳过（不抛 Render frame was disposed）
      const readySent = safeSend('pet:command', {
        type: 'ready',
        clickThrough: ignoring,
        // 首帧就带上可见性：桌宠可能在"窗口已隐藏"的前提下被重新加载，
        // 渲染层据此直接进 off 档，而不是先按"可见"跑一轮动画再被纠正
        visible: win.isVisible(),
        size: { width: initial.width, height: initial.height },
      });
      // 偏好也要补一条（§8.2：`ready` 之后 1 条）：渲染层据此决定"允不允许请求跟随/漫游"。
      // 不补的话，文档重载后渲染层会以为两个开关都是关的（它默认 follow=false），
      // 于是用户明明勾了跟随开关，猫也永远不动。
      //
      // **只有 ready 真的发出去了才发**：渲染层不可达时再发一条只会多刷一条无意义的告警
      // （E2 用例守着"一次失败只 warn 一次"），信息也不会被任何人收到。
      if (!readySent) return;
      const current = prefsPort.getPrefs();
      const snapshot = { follow: current.follow === true, roam: current.roam !== false };
      safeSend('pet:command', { type: 'prefs', follow: snapshot.follow, roam: snapshot.roam, prefs: snapshot });
    });

    // 渲染层崩了不能把一个空黑框留在桌面上；顺手解掉拖拽的强制可交互
    // （否则窗口"强制可交互 + 已隐藏"会一直挂着，直到下次 create）
    win.webContents.on('render-process-gone', () => {
      console.warn('[pet] 渲染进程退出，收起桌宠窗口');
      poller?.setForced('drag', false);
      hide();
    });

    // 窗口移动/缩放 → 命中矩形的屏幕平移量要跟着变，否则拖到哪儿都按旧位置判
    win.on('move', windowBoundsChanged);
    win.on('resize', windowBoundsChanged);

    // 例外③：隐藏即停表（被隐藏的窗口里定时器照常跑，所以停表必须发生在这里，
    // 不能指望渲染层的功耗档位——那是视觉档，不是 CPU 判据）
    win.on('show', () => {
      poller?.setSuspended('hidden', false);
      motion?.setSuspended('hidden', false);
      poller?.poll();
      notifyVisibility();
    });
    win.on('hide', () => {
      poller?.setSuspended('hidden', true);
      motion?.setSuspended('hidden', true);
      notifyVisibility();
    });
    // 例外②的兜底：原生菜单会夺焦，失焦说明菜单已经收了（某些 Windows 版本不回调 callback）
    win.on('blur', () => poller?.setForced('menu', false));
    win.on('close', () => {
      // destroy 之前把最后位置记下来
      flushSave();
    });
    win.on('closed', () => {
      // 例外①的第三条解除路径：窗口没了，拖拽的强制可交互必须一起清掉
      poller?.setForced('drag', false);
      motion?.stop();
      motion = null;
      poller?.stop();
      poller = null;
      dragging = false;
      win = null;
      notifyVisibility();
    });

    if (entry.kind === 'url') {
      win.loadURL(entry.value);
    } else {
      win.loadFile(entry.value);
    }
    return win;
  }

  /**
   * 把桌宠窗口显示出来（不存在就创建）。
   *
   * @returns BrowserWindow 实例
   */
  function show() {
    const created = create();
    if (!created) return null;
    if (created.isMinimized()) created.restore();
    created.showInactive();
    notifyVisibility();
    return created;
  }

  /** 显示 / 隐藏切换（托盘菜单用）。 */
  function toggle() {
    if (isVisible()) hide();
    else show();
  }

  // ---------------------------------------------------------------- IPC

  /**
   * 渲染层：按下左键，开始拖拽（记录光标相对窗口的偏移）。
   *
   * <p><b>例外①：拖拽期间强制可交互。</b>轮询器每 16ms 读一次光标，而拖拽时用户常常把指针
   * 甩到窗口外（宠物被"拎着"跑得比指针慢），一旦轮询把窗口切回穿透，`pointerup` 就再也
   * 不会到达渲染层 ⇒ 拖拽中断、窗口卡在半路。所以拖拽期间命中判定整体让位。</p>
   */
  ipcMain.handle('pet:drag-start', (event, payload) => {
    if (!isFromPet(event)) return { ok: false, error: '来源未授权' };
    if (!win || win.isDestroyed()) return { ok: false, error: '桌宠窗口不存在' };
    const bounds = win.getBounds();
    const pointerX = Number(payload && payload.cursorX);
    const pointerY = Number(payload && payload.cursorY);
    let originX = pointerX;
    let originY = pointerY;
    if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
      // 渲染层没给坐标（或给了脏值）时用系统光标位置兜底
      const cursor = electron().screen.getCursorScreenPoint();
      originX = cursor.x;
      originY = cursor.y;
    }
    dragOffset = { x: Math.round(originX) - bounds.x, y: Math.round(originY) - bounds.y };
    dragging = true;
    poller?.setForced('drag', true);
    // L3：把运动层**从定时器的订阅表里摘掉**（不是"回调里判一下 owner 就跳过"）。
    // 从这一拍起，定时器碰不到位置写入，于是 `pet:drag-move` 与自主移动在任何时刻
    // 只有一个写者——这是结构保证，不是时序运气。
    motion?.beginDrag();
    return { ok: true };
  });

  /**
   * 渲染层：拖拽过程中的位置上报。
   *
   * <p>用 `send` 而不是 `invoke`：拖拽是高频单向事件，等一轮 promise 往返会明显拖慢跟手感。</p>
   */
  ipcMain.on('pet:drag-move', (event, payload) => {
    if (!isFromPet(event)) return;
    if (!dragging || !win || win.isDestroyed()) return;
    let cursorX = Number(payload && payload.cursorX);
    let cursorY = Number(payload && payload.cursorY);
    if (!Number.isFinite(cursorX) || !Number.isFinite(cursorY)) {
      const cursor = electron().screen.getCursorScreenPoint();
      cursorX = cursor.x;
      cursorY = cursor.y;
    }
    // 拖拽的位置写入也走运动层的唯一写点（`applyPosition` 的 `drag` 令牌那一支）：
    // 本文件里没有任何一处自己移动窗口，否则"唯一写者"就只是句口号。
    if (motion) {
      // 兜住 `dragTo` 的入参/派生校验错误：拖拽是高频 `send`，一次畸形载荷
      // 不该让未捕获异常打崩主进程（Q-M1）。异常照旧抛出（契约不变），
      // 但边界处必须吞掉并说出来——静默 = 下一个排查的人要重走一遍我今天的路。
      let wrote = false;
      try {
        wrote = motion.dragTo(cursorX, cursorY, dragOffset.x, dragOffset.y);
      } catch (err) {
        console.warn(`[pet] 拖拽坐标被拒绝: ${(err && err.message) || err}`);
        return;
      }
      if (wrote) scheduleSave();
      return;
    }
    // 窗口存在但运动层没建起来（理论不可达：两者都在 create() 里成对创建）——
    // 宁可这一帧不动，也不在这里开第二条写路径。
  });

  /** 渲染层：松开左键，结束拖拽并立即落盘。 */
  ipcMain.handle('pet:drag-end', (event) => {
    if (!isFromPet(event)) return { ok: false, error: '来源未授权' };
    dragging = false;
    // 解除强制可交互并**立即**收敛：光标可能已经在窗外，等下一拍会让用户先看到 16ms 的可交互
    poller?.setForced('drag', false);
    // 写入权还给运动（若还有运动）——这一步同时把 onSample 订阅接回来
    motion?.endDrag();
    flushSave();
    return { ok: true };
  });

  /**
   * 渲染层：悬停提示（**只负责叫醒，绝不参与判定**）。
   *
   * <p><b>它的定位是「让手型立刻出现」，不是抢救快点击。</b>产品裁定：立刻点那几十毫秒
   * 不用优化，所以轮询定在 16ms（一帧）；但 16ms 的空档会让手型"迟到一拍"，观感上是
   * 压上去先亮箭头再变手型，像在抖。于是保留这条即时触发器：穿透态下窗口收不到点击，
   * 却收得到 `{ forward: true }` 转发的 `mousemove`（勘误：早前"零投递"的结论是
   * `SetCursorPos` 造成的假阴性），渲染层把它变成这一条 IPC，主进程当场读光标 + 同步 apply，
   * 手型/可交互在 1~5ms 内出现。</p>
   *
   * <p><b>防回声的结构性保证：</b>①本处理器**不读载荷**（那里面的坐标渲染层可以随便编，
   * 读了就等于把判定权还回去——伪造一条 hint 不会让状态变，C20 守着）；
   * ②`poller.poll()` 内部没有任何定时器，`setIgnoreMouseEvents` 发生在这次 IPC 的调用栈里；
   * ③hint 整条失效时仍有 16ms 轮询兜底（C13 把监听删掉再验一遍）。</p>
   */
  ipcMain.on('pet:hover-hint', (event) => {
    if (!isFromPet(event)) return;
    poller?.poll();
  });

  /** 渲染层：关掉桌宠（隐藏而不销毁：下次从托盘打开就在原地）。 */
  ipcMain.handle('pet:close', (event) => {
    if (!isFromPet(event)) return { ok: false, error: '来源未授权' };
    hide();
    return { ok: true };
  });

  /**
   * 渲染层：弹出原生右键菜单（M6-b 的 O3 + D-B2）。
   *
   * <p><b>为什么关闭入口收敛到这里：</b>以前有两套手势（双击立绘 + 悬停显形的 × 按钮），
   * 而"连点 3 下生气"也要用连点，于是双击必然先记一次 tap 再被关闭抢走语义。
   * 现在关闭/显隐只走原生菜单：DOM 侧不再有任何关闭元素，也不再有双击语义。</p>
   *
   * <p>用 `Menu.popup()` 而不是自绘菜单：原生菜单不占渲染层的合成预算，
   * 而且窗口本身是 `focusable: false`，自绘菜单会先要一次焦点、把用户的输入焦点抢走。</p>
   *
   * <p><b>例外②：菜单打开期间强制可交互。</b>菜单是独立窗口，但光标在菜单与桌宠之间移动时
   * 轮询器会认为"离开宠物"，把主窗口切回穿透——菜单随之失去宿主，用户点不到菜单项。
   * 解除点只有一个（`popup` 的 `callback`，即菜单关闭），另加 `win.on('blur')` 兜底：
   * 某些 Windows 版本菜单关闭不回调，卡在"强制可交互"就是整窗吃鼠标。</p>
   */
  ipcMain.on('pet:context-menu', (event) => {
    if (!isFromPet(event)) return;
    const { Menu } = electron();
    // 模板**只有一个来源**：`pet-menu.cjs`（与托盘菜单共用开关段与文案常量）。
    // 本文件里不许再出现任何菜单文案字面量（G-M9），勾选态一律从偏好现读。
    const template = menuBuilder.buildContextMenuItems({
      prefs: prefsPort.getPrefs(),
      isVisible: isVisible(),
      actions: createMenuActions(),
    });
    const menu = Menu.buildFromTemplate(template);
    // 先置强制再弹：弹出那一刻光标已经在菜单上，晚一步就会被切回穿透
    poller?.setForced('menu', true);
    // 菜单打开期间猫停住（§8.3）：它不需要移开，移动反而让菜单"追不到宿主"
    motion?.setSuspended('menu', true);
    menu.popup({
      window: win || undefined,
      callback: () => {
        poller?.setForced('menu', false);
        motion?.setSuspended('menu', false);
      },
    });
  });

  /**
   * 右键菜单的动作表（**全部落到本文件已有的能力上**，不新造写路径）。
   *
   * <p>两个开关动作只做一件事：把"取反后的值"交给偏好端口——落盘 / 广播 / 重建菜单
   * 由 `pet-prefs-wiring.cjs` 按固定顺序完成（先落盘 → 广播 → 重建）。本文件不碰文件，
   * 也不自己记一份偏好。</p>
   *
   * @returns {Record<string, Function>} 动作表
   */
  function createMenuActions() {
    return {
      toggleVisible: () => toggle(),
      toggleFollow: () => {
        const current = prefsPort.getPrefs();
        prefsPort.setPrefs({ follow: current.follow !== true });
      },
      toggleRoam: () => {
        const current = prefsPort.getPrefs();
        prefsPort.setPrefs({ roam: current.roam !== true });
      },
      closePet: () => hide(),
      quitApp: () => electron().app.quit(),
    };
  }

  /**
   * 渲染层：请求切换运动模式（§8.1，`invoke`）。
   *
   * <p><b>载荷里没有坐标</b>（意图不含几何）：渲染层永远不能指定位置。受理结果原样回给
   * 渲染层——"被拒"必须说出来（真机上"猫不动"要有原因可查），不许静默。</p>
   *
   * <p><b>载荷里的可选 `behavior` 是"上报"不是"命令"</b>（S4.1 纵深防御）：主进程把它记进
   * `MotionController#behavior`，之后自己用它做闸——行为态为 `sleeping` / `sleep` / `drag`
   * 时 `trySetMode('roam'|'follow')` 会被主进程拒绝（`reason:'behavior-blocked'`），
   * 且若此刻正在动会立刻停下。**顺序固定：先记录上报、再判意图**，否则同一次 invoke 里
   * "刚要睡 + 开漫游"会被放过去。</p>
   */
  ipcMain.handle('pet:motion-intent', (event, payload) => {
    if (!isFromPet(event)) return { ok: false, error: '来源未授权' };
    if (!motion) return { ok: false, error: '桌宠窗口不存在' };
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    if (typeof safePayload.behavior === 'string') motion.reportBehavior(safePayload.behavior);
    return motion.trySetMode(safePayload.mode, safePayload.reason);
  });

  /** 渲染层/排障：读运动快照（只读，§8.1）。 */
  ipcMain.handle('pet:motion-snapshot', (event) => {
    if (!isFromPet(event)) return { ok: false, error: '来源未授权' };
    return motion ? motion.snapshot() : null;
  });

  /**
   * 渲染层：写偏好（§8.1，**只有 dev 后门会调**；生产态唯一写入者是右键菜单）。
   *
   * <p>一件容易搞错的事：这里**不做任何字段校验**。类型过滤、未知键忽略、原子写、
   * 广播、重建菜单全在偏好端口里（唯一路径），本文件只转发。自己再判一遍就等于
   * 制造第二个判据，早晚与端口不一致。</p>
   */
  ipcMain.handle('pet:prefs-set', (event, payload) => {
    if (!isFromPet(event)) return { ok: false, error: '来源未授权' };
    return prefsPort.setPrefs(payload);
  });

  return {
    create,
    show,
    hide,
    toggle,
    isVisible,
    destroy,
    /**
     * 订阅可见性变化（托盘用来刷新勾选状态）。
     *
     * @param listener 回调，参数为当前是否可见
     * @returns 取消订阅函数
     */
    onVisibilityChange(listener) {
      if (typeof listener !== 'function') return () => {};
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    /**
     * 当前偏好（右键菜单与托盘共用同一个来源）。
     *
     * @returns {{version: number, follow: boolean, roam: boolean}} 偏好快照
     */
    getPrefs: () => prefsPort.getPrefs(),
    /**
     * 写偏好（**唯一路径**：落盘 → 广播 → 重建菜单，全在偏好端口里）。
     *
     * @param {{follow?: boolean, roam?: boolean}} patch 补丁
     * @returns {{prefs: object, ok: boolean, problems: string[], changed: boolean}} 结果
     */
    setPrefs: (patch) => prefsPort.setPrefs(patch),
    /**
     * 订阅偏好变化（托盘据此刷新勾选态）。
     *
     * @param {(prefs: object) => void} listener 回调
     * @returns {() => void} 取消订阅
     */
    onPrefsChange: (listener) => prefsPort.onPrefsChange(listener),
    /**
     * 运动快照（只读；dev 后门与 CDP 采样用）。窗口不存在时为 `null`。
     *
     * @returns {object|null} 快照
     */
    motionSnapshot: () => (motion ? motion.snapshot() : null),
    /** 状态文件路径（排障用：用户报「位置记不住」时直接看这个文件）。 */
    statePath: resolvedStatePath,
  };
}

module.exports = {
  registerPetWindow,
  resolveDevEntryUrl,
  resolveEntrySpec,
  DEV_ENTRY_FALLBACK,
  PET_ENTRY_PAGE,
  normalizeDimension,
  intersectArea,
  clampRectToWorkArea,
  clampIntoWorkArea,
  defaultRect,
  pickDisplay,
  migrateSavedBounds,
  resolveInitialBounds,
  readState,
  writeState,
  ART_ORIGIN,
  LEGACY_ART_ORIGIN,
  PET_WIDTH,
  PET_HEIGHT,
  ART_WIDTH,
  ART_HEIGHT,
  GLOW_PAD,
  BUBBLE_H,
  EDGE_MARGIN,
  STATE_FILE_NAME,
  MIN_VISIBLE_RATIO,
};
