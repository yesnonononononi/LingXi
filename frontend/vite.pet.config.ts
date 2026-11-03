import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config.ts'
import { createPetViteOverrides } from './electron/pet-dev-endpoint.cjs'
// 必须是 ESM：本 config 会被 Vite 用 esbuild 打成 ESM 再执行，被内联的 CJS 模块里
// `require('node:crypto')` 会变成动态 require 垫片，直接抛
// `Error: Dynamic require of "node:crypto" is not supported`（实测踩过）。
import { createTreeFingerprintPlugin } from './electron/pet-tree-fingerprint.mjs'

/**
 * 桌宠专用 Vite 配置（`npm run dev:pet`）。
 *
 * <p><b>为什么桌宠要有一份自己的 config，而不是复用 `vite.config.ts`：</b>
 * 桌宠入口 `pet.html` 与主应用 `index.html` 同处一个 Vite root，历史事故就是这样发生的——
 * 端口 5174 被主应用的 dev server 占住后，`GET /pet.html` 被 SPA history fallback
 * **兜成 `index.html` 且仍返回 200**，探活误判"桌宠已就绪"，Electron 窗口里显示整个主应用。</p>
 *
 * <p>本 config 只做三件事，全部来自单一真源 `electron/pet-dev-endpoint.cjs`：</p>
 * <ol>
 *   <li>`server.port` = 独立端口，与主应用 5174 隔离；</li>
 *   <li>`server.strictPort: true`：端口被占**硬失败**，绝不静默 +1 漂移；</li>
 *   <li>`appType: 'mpa'`：关掉 history fallback，`/pet.html` 缺失时返回 404 而不是 `index.html`。
 *       这是"取 /pet.html 一定是桌宠页面"的根因级保证。</li>
 * </ol>
 *
 * <p>其余（`base`、`plugins`、`build.rollupOptions.input`、`server.proxy`、`hmr: false`）
 * 从 `vite.config.ts` 合并继承，避免两份配置各自漂移——端口/proxy 前缀清单这类真源
 * 只有一份。</p>
 *
 * <p>用法：`npm run dev:pet`（不要用 `vite --port xxx` 覆盖端口：探活脚本认的就是
 * 单一真源里的端口，覆盖会让"探活目标"和"实际服务"再次分裂）。</p>
 */
const petOverrides = createPetViteOverrides()

export default defineConfig(
  mergeConfig(baseConfig, {
    // 多入口模式：dev 下不注册 html/spa fallback 中间件
    appType: petOverrides.appType,
    server: petOverrides.server,
    // 树指纹：往 pet.html 注入 <meta name="lx-pet-tree" content="<摘要>">。
    // 这是"守卫验的是本地这棵树"的唯一强证据 —— 详见 electron/pet-tree-fingerprint.mjs。
    // 没有它，画面守卫只能证明"这是个桌宠页面"，证明不了"是本地的桌宠页面"，
    // 就可能把另一个工作树（同端口真源）的渲染结果当成 PASS。
    plugins: [createTreeFingerprintPlugin()],
  }),
)
