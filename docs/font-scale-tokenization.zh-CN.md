# 全局字号令牌体系（维护说明）

> **真源三处，缺一即红**：`frontend/src/theme/tokens.css`（值）、`frontend/src/theme/tokens.ts`（元数据/分组）、
> `frontend/src/style.css` 的 `@theme inline`（工具类桥）。运行时唯一的写入口是
> `frontend/src/composables/useFontScale.ts`。
> 本文解释「为什么这么设计、新代码该怎么用、新增一档要动哪几处」，判据的唯一实现仍在代码与测试里。

---

## 1. 8 档字号令牌

| 令牌（`--lx-font-size-*`） | 工具类（`text-lx-fs-*`） | 基准值 | 典型用途 |
|---|---|---|---|
| `2xs` | `text-lx-fs-2xs` | 9px | 角标、极小徽标（原 `text-[9px]`） |
| `xs` | `text-lx-fs-xs` | 10px | 次要说明、标签（原 `text-[10px]`，全站第二大档） |
| `sm` | `text-lx-fs-sm` | 11px | 主力小字（原 `text-[11px]`，全站占比最高） |
| `md` | `text-lx-fs-md` | 12px | 正文字号（原 `text-[12px]`） |
| `lg` | `text-lx-fs-lg` | 13px | 偏大正文（原 `text-[13px]`） |
| `xl` | `text-lx-fs-xl` | 14px | 大字号、内联 `font-size`（原 `text-[14px]`） |
| `2xl` | `text-lx-fs-2xl` | 16px | 标题档 |
| `3xl` | `text-lx-fs-3xl` | 18px | 最大档 |

- **值 = 基准 px × `var(--lx-font-scale, 1)`**，默认态不写 `--lx-font-scale`，所以默认档求值与迁移前的硬编码 px 逐位相等。
- `tokens.css` 的 `:root`（暗）与 `html.light`（亮）**两块同值声明**：字号是几何量，明暗共用同一基准值；亮色块只是满足「每个令牌都要有亮色值」的结构门禁。
- 用 px 不用 rem：本仓布局间距/尺寸是 rem（约 2210 处），字号若也用 rem 就会跟着根字号放大，变成「框和字一起放大」——违反「只放大字、不放大框」的口径。
- `theme/tokens.ts` 里这 8 条登记为 `typography` 分组且 **`overridable = false`**：字号是可用性偏好，主题包改字号等于把界面撑坏（与 radius/shadow 同理）。

---

## 2. 运行时缩放：`--lx-font-scale`

| 项 | 值/位置 |
|---|---|
| 变量 | `--lx-font-scale`，挂在 `documentElement` 上 |
| 取值范围 | `0.875 ~ 1.5`（越界夹紧，非法值回落默认档） |
| 唯一写入口 | `composables/useFontScale.ts` 的 `applyToDocument` |
| 档位 → 倍数 | `SMALL 0.875 / MEDIUM 1 / LARGE 1.125 / X_LARGE 1.25`（`PRESET_SCALE`） |
| 后端真源 | `user_configs.font_scale`，四档白名单 `SMALL` / `MEDIUM` / `LARGE` / `X_LARGE`，未设置由后端归一成 `MEDIUM` |
| 首帧镜像 | `localStorage['lingxi-font-scale']` + `index.html` 内联脚本（与 `lingxi-theme` 同风格） |

**默认档零写入是硬约束**：倍数为 `1` 时走 `removeProperty`，**不写** `--lx-font-scale: 1`。写 `1` 会让 `calc(11px * 1)` 这类求值从「变量未设置」变成「已设置」，等价性判据与截图比对都可能翻车（视觉基线按默认态采集）。除 `useFontScale.ts` 外任何地方都不得写这个变量。

`useFontScale` 是模块级单例：设置页与聊天页读同一份状态；偏好变化由 `watch(store.fontScale)` 单向驱动，不在别处再写一次。

---

## 3. 怎么消费

| 场景 | 写法 |
|---|---|
| 模板 className | `class="text-lx-fs-sm"`，变体照常：`hover:text-lx-fs-md`、`dark:text-lx-fs-xs` |
| `<style>` 块 | `font-size: var(--lx-font-size-sm);` |
| 相对某令牌缩放 | `font-size: calc(var(--lx-font-size-xl) * 52 / 35);`（整数比，见下） |

**禁止**再写 `text-[Npx]` / `font-size: Npx`。这两类硬编码是本次迁移的负债来源；新代码再写等于把债还回去，且不会随字号偏好变化。

**不要用 `em` 做相对缩放**：`em` 走 float32，非 2 的幂分母会掉精度（实测 `1.4857142857142858em` 求值 20.7999px，而旧的 `1.3rem` 是 20.8px）。需要「相对某令牌的倍数」时用 `calc(令牌 × 整数比)`，求值逐位相等。

布局宽度不参与令牌化：`--container-lx-chat` 等宽度仍是字面量（AGENTS.md「对话列宽单一真源」），字号缩放不得改变列宽。

---

## 4. 新增一档要改几处

三处必改，一处在新增高阶语义档时可选：

1. `frontend/src/theme/tokens.css`：`:root` 与 `html.light` **两块**都加 `--lx-font-size-*`（形如 `calc(<基准>px * var(--lx-font-scale, 1))`）。
2. `frontend/src/theme/tokens.ts`：`typography` 分组加一条 `def('font-size-*', 'typography', false, '<用途说明>')`。
3. `frontend/src/style.css` 的 `@theme inline`：加 `--text-lx-fs-*: var(--lx-font-size-*);`，工具类由此派生。
4. （可选）`frontend/src/theme/mapping.ts`：只有需要语义档别名表时才加。

**缺任一处都会红**：`themeTokens.test.ts` 的 `T2-2`（`tokens.ts` 与 `tokens.css` 令牌名双向差集为空）、`T3-1`（每个令牌要么有 `@theme` 映射、要么显式登记不映射）、`T4-4`（每个 `typography` 令牌必须能反推成 `--text-lx-fs-*` 且该映射在 `@theme` 里存在）。

---

## 5. 门禁与台账

### 5.1 `frontend/tests/themeTokens.test.ts`（结构门禁，18 项，当前全绿）

- `T2-1/T2-2/T2-4`：亮 ⊆ 暗、令牌名与 `tokens.ts` 双向一致；**明暗同值只允许出现在豁免集**。豁免集 `SAME_BY_DESIGN` 由 `group === 'shape' || group === 'typography'` 派生，另加 `text-on-accent`——字号天生明暗同值，属设计要求，不是豁免兜底。
- `T3-1/T3-2/T3-3`：每个令牌要么有映射要么显式登记不映射；映射不得写死值；不得有指向不存在令牌的 `@theme` 键。
- `T4-4`：`classToThemeVar` 必须**先匹配 `text-lx-fs-` 再匹配 `--color-lx-`**。否则 `text-lx-fs-sm` 会被反推成 `--color-lx-fs-sm` 而误报红（`text-lx-primary` 与 `text-lx-fs-*` 共享 `text-lx-` 前缀）。

### 5.2 `frontend/scripts/check-theme-equivalence.mjs`（等价性门禁，4 层）

- 第 1 层（静态层）对「命中令牌前缀却解析不到取值」的类报「写错令牌名」。字号令牌天然没有颜色取值（`resolveClass` 拿到的是 `calc(11px * var(--lx-font-scale, 1))`），因此有**收窄豁免** `isNonColorTokenClass`。放行需同时成立：① 类名以 `text-lx-fs-` 开头；② `@theme` 桥能反查到目标令牌；③ 该令牌在 `tokens.css` 明/暗两套里真有定义。**写错档位（`text-lx-fs-smm`）反查不到 → 仍旧报红。**
- 第 3 层「非颜色字面量多重集严格比」**不放宽**：字号替换的等价性靠台账（见 5.3）而不是靠放宽判据。
- 自检（`--selftest`）带变异体断言：`filterUnknown` 只放行真令牌；静态层本体确实接入了豁免；桥里有键但 `tokens.css` 无定义不放行；`shadow-lx-1` 这类形态类不被吞掉。

### 5.3 `frontend/scripts/theme-spec/token-renames.json`（改名台账）

门禁比对「HEAD 基线 vs 工作树」时，会先按台账把基线侧的旧名替换成新名再解析——否则改名后基线侧解析不到已不存在的令牌，只能报数量不一致，等于无法验证。

字号替换已登记 **6 条**（按 class 名成对登记）：

| 旧名 | 新名 | 阶段 |
|---|---|---|
| `text-[11px]` | `text-lx-fs-sm` | S2（123 处 / 29 文件，纯同值替换） |
| `text-[9px]` | `text-lx-fs-2xs` | S3 |
| `text-[10px]` | `text-lx-fs-xs` | S3 |
| `text-[12px]` | `text-lx-fs-md` | S3 |
| `text-[13px]` | `text-lx-fs-lg` | S3 |
| `text-[14px]` | `text-lx-fs-xl` | S3 |

`<style>` 块里的 `font-size: Npx → var(--lx-font-size-*)` **不需要也不能登记**：门禁的 `groupsOf` 只收集字符串字面量里的类名，CSS 声明它看不见。

---

## 6. ADR 决策记录（4 条）

**ADR-1｜第 1 层判据的定义改了。** 由「令牌类必须有颜色取值」改为「令牌类必须有**真实令牌定义**或有颜色取值」。原判据隐含「所有令牌类都是颜色类」，字号令牌一引入就整片误报；新判据把「能不能反查到真实令牌」作为共同前提，颜色正则退为其中一支。

**ADR-2｜豁免范围只给 `text-lx-fs-*`，且只作用于「写错令牌名」这一条结论。** 不用「类名恰好等于桥键名」这种命名巧合做判据（那样 `shadow-lx-1`、`blur-lx-panel` 会被一并放行）；前缀显式写死，豁免面 = 8 档字号，多一个都不给。第 3 层多重集比对**仍旧严格**，不因本条放宽。

**ADR-3｜台账里字号替换的等价性只在默认档 `scale = 1` 成立。** 令牌值是 `calc(<基准>px * var(--lx-font-scale, 1))`，非默认档下求值必然不同——等价性结论的适用范围就是这个前提。**若将来改动基准档位或默认倍数，必须重审 `token-renames.json` 里全部 6 条字号登记**，不能沿用旧结论。

**ADR-4｜口径：字号类不走颜色通道是设计使然，禁止为让门禁变绿去动容差。** 不允许调大 `TOL`、不允许新增 `--allow-*` 开关、不允许在 `compare`/`compareColorGroups` 里加字号特例。要绿只能：判据收窄（ADR-2 的做法）、台账登记、或补上真实令牌定义。

---

## 7. 已知缺口（留痕不掩盖）

1. **视觉零漂移只是「计算样式级」证明，不是像素级。** 本次迁移时本机没有可用的截图 baseline（`.lingxi/tmp` 被 gitignore），因此「零漂移」的证据是 Electron 探针逐项比对计算样式（27 项逐位相等），而非像素比对。若要像素级结论，必须在**迁移前的干净基座**上先录一次 baseline 再比对；现状无法补录。
2. **第 1 层豁免不验产物、不验取值形态。** 它查的是 `@theme` 桥而不是产物规则表，也不走颜色通道的 `normalizeColor`/`parseRgba`。风险量化为低（扫描集 ⊆ Tailwind 自动扫描集，字号类在源码里都是字面量），加强办法见评审 C4。
3. **小数与特例字号仍是 px。** 类名侧残留 6 处小数档：`11.5px`×1、`12.5px`×1、`13.5px`×3、`15px`×1；`BatchModelsForm.vue` 里还有 `font-size:26px`（返回箭头图标）与 `font-size:15px`（成功标题）。它们没有对应令牌，本轮按「保留 px」处理。要收需先决定「并入整档（会产生 ±0.5px 漂移）还是新增令牌」。
4. **界面整体缩放与字号缩放会相乘。** 若将来引入 `webFrame.setZoomFactor` 一类的整体缩放，必须与字号缩放互斥或明确乘积上限，否则两套倍数叠乘。
5. **`@media print` / 导出场景未核查。** 若存在固定 px 字号，打印结果不随字号偏好变化，是否可接受需产品确认。

---

## 8. 维护清单（改字号相关判据时）

- 改令牌值/档位 → `tokens.css` 两块 + `tokens.ts` + `style.css` 三处同改，跑 `npx tsx --test tests/themeTokens.test.ts`。
- 改豁免判据 → 同步 `check-theme-equivalence.mjs` 自检的变异体断言，跑 `node scripts/check-theme-equivalence.mjs --selftest`。
- 改台账 → 只登记 class 名替换；改基准档位要同时重审台账的等价性前提（ADR-3）。
- 改 `--lx-font-scale` 写入逻辑 → 只能改 `useFontScale.ts`，并确认默认档仍走 `removeProperty`（默认态零写入）。
