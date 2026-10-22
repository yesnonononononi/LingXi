# theme-spec —— 主题令牌数值真值源

## 这个目录是什么

主题令牌（`src/theme/tokens.css` 里的 `--lx-*`）**取值**的机器可比对真值源。

过去 `tests/themeTokens.test.ts` 的 17 条用例只守**结构**一致性（令牌名存在、`@theme inline`
桥接层有条目、明暗两套都有值）。把 `--lx-text-muted` 改回错值 `#71717a` 时，这 17 条
**17/17 全绿照样逃逸**——「令牌值对不对」只能靠人工 audit。本目录就是补这个洞的数据源。

## 为什么放在 `frontend/scripts/theme-spec/`（而不是 `src/` 或仓库根）

1. **它是门禁的数据资产，不是应用运行时代码**：放在 `scripts/` 下不会被 vite 打进 `dist`，
   也不会被 `vue-tsc` 的类型检查扫进来（`src/` 是编译输入，塞数据文件会污染编译边界）。
2. **与消费它的脚本同级**：`scripts/check-theme-equivalence.mjs` 用
   `path.join(__dirname, 'theme-spec', 'token-value-spec.json')` 定位，路径用 `import.meta.url`
   自解析，从 `frontend/` 调用与从仓库根调用结果完全一致，不依赖 cwd、不依赖 `../../../` 层数。
3. **不依赖 `.lingxi/`**：原真值源在 `.lingxi/tmp/m3/m3a-class-map.json`（临时目录、不入库、
   随时会被清理）。迁入这里后仓库自带真值，CI/新克隆的环境都能跑。

## 文件

- `token-value-spec.json` —— 唯一真值源，`schemaVersion: 1`。

## 数据结构

```jsonc
{
  "schemaVersion": 1,
  "compareContract": { /* 归一化口径 + 容差，供人读 */ },
  "provenance":      { /* 迁移来源、条目数、expected 的推导方式 */ },
  "tokens": [
    {
      "token":         "--lx-text-muted",   // tokens.css 里的变量名
      "name":          "text-muted",        // 语义角色名
      "group":         "text",              // text / border / surface / accent / status
      "status":        "rederive",          // rederive（取值重新推导）/ add（新增令牌）
      "darkClass":     "text-zinc-400",     // 暗色代言类名（改造前真实使用的 Tailwind 类）
      "lightClass":    "text-gray-500",     // 亮色代言类名
      "expectedDark":  "#9f9fa9",           // 该代言类名的期望取值（归一化口径）
      "expectedLight": "#6a7282",
      "themeKey":      "--color-lx-muted",  // style.css @theme inline 桥接变量
      "utilityClass":  "text-lx-muted",     // 组件侧使用的令牌工具类
      "note":          "…"                  // 决策依据（人工可读）
    }
  ]
}
```

## 门禁怎么用它

```bash
cd frontend
npm run gate:theme:values         # 需要已有 dist 产物（npx vite build）
npm run gate:theme:values:build   # 先 build 再校验
node scripts/check-theme-equivalence.mjs --check-token-values   # 等价写法
```

校验逻辑（`check-theme-equivalence.mjs` 第 4 层）：

1. 读 `frontend/dist/assets/*.css` **全部 chunk**（ChatView / CodePreview / main / notification），
   用 `check-theme-colors.mjs` 的 `resolveClass()` 解析 `darkClass` / `lightClass` 的真实取值
   （复用既有 color-resolver，不另写解析器）。
2. 与 `tokens.css` 对应模式的当前值**归一化后**比对：
   `rgba(r,g,b,a)` ⇄ `#rrggbb@0.aaa`、`#rgb` ⇄ `#rrggbb`、alpha 补三位小数、`oklch()` 反算、
   `color-mix(in oklab, … N%, transparent)` 按 `round(N%*255)/255` 量化。
3. 容差与主门禁 `TOL` 一致（rgb ≤ 8/255、alpha ≤ 0.01）：高饱和色在「设计侧字面量」与
   「产物侧 hex」两条独立推导间必然差几通道，那是解析精度；「改错值」这类真实漂移
   （如 `#9f9fa9` → `#71717a` 差 46）依然必红。
4. 同时核对 `expected*` 与产物真实值，防止「产物或真值源被单独改动后共同漂移」。
5. 产物缺失 → 退出码 1（无法执行）；产物早于源码 → 拒绝判定（`--allow-stale` 才放行）；
   mismatch → 打印「令牌名 / 期望值 / 实际值 / 代言类名」并以退出码 2 结束。

## 改这里等于改设计结论

`expectedDark/expectedLight` 不是文档，是**判据**：

- 调整令牌取值属于**全局视觉变更**，必须改这里的 expected 并走评审，不允许为了让门禁变绿
  去改 expected；
- 新增令牌时补一条记录（8 个字段齐全），否则 `loadTokenValueSpec()` 会因缺字段直接报错退出 1；
- 迁移自 `.lingxi/tmp/m3/m3a-class-map.json` 的 20 条映射结论（谁代言谁、`rederive`/`add`、
  note）**一字未改**，只补了 `token` / `expected*` 两个便于机器比对与阅读的字段。
