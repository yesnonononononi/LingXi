import {defineConfig, type Plugin} from 'vite'
import vue from '@vitejs/plugin-vue'
import {resolve} from 'node:path'
// 桌宠静态资产隔离的唯一真源（纯函数 + 零 electron 依赖）。
// 类型声明见同目录的 `pet-asset-isolation.d.mts`（`tsconfig.node.json` 未开 `allowJs`）。
import {isolatePetAssetsFromDist} from './scripts/pet-asset-isolation.mjs'

const url = 'http://localhost:8089'

/**
 * 生产构建的**桌宠静态资产隔离**插件（M2 线A任务 2）。
 *
 * <p><b>为什么必须做：</b>`vite build` 会把整个 `public/` 拷进 `dist/`，而
 * `public/live2d/` 下全部是桌宠资产（4 个 `pet-*` 目录，约 9 MiB / 132 文件，占主包三成）。
 * 安装版不展示桌宠，这些字节是纯浪费。</p>
 *
 * <p><b>为什么不动 `publicDir`：</b>它是开发态与构建态共用的语义。改它会让
 * 5275 的 `vite.pet.config.ts`、electron 开发态的 `lxa://` extraBases
 * （`electron/main.cjs` 的 `public/live2d`）以及 `pet.html` 的资产加载一起退化。
 * 所以这里只在**构建写盘完成之后**裁剪 `dist/live2d/pet-*`。</p>
 *
 * <p><b>为什么是 `closeBundle` + `order: 'post'`：</b>`public/` 的拷贝发生在写盘阶段，
 * 早于 `closeBundle`；`order: 'post'` 保证本钩子排在所有其它 closeBundle 之后，
 * 不会被后来者重新写回文件。`apply: 'build'` 保证 dev server 一个字节都不受影响。</p>
 *
 * <p>守卫：`node scripts/check-pet-not-shipped.mjs` 断言 `dist/` 里没有 `pet-*` 目录，
 * 见 `tests/petNotShipped.test.cjs` 的反例用例（隔离失效必须红）。</p>
 *
 * @returns Vite 插件
 */
function petAssetIsolation(): Plugin {
  /** 解析后的产物目录（`configResolved` 里由 Vite 归一化成绝对路径）。 */
  let distDir = resolve(__dirname, 'dist')
  return {
    name: 'lingxi:pet-asset-isolation',
    apply: 'build',
    configResolved(config) {
      // `build.outDir` 在 resolved config 里已是绝对路径；跟随它可避免"改了 outDir 就漏删"
      distDir = resolve(config.root, config.build.outDir)
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const result = isolatePetAssetsFromDist(distDir)
        for (const dir of result.removed) {
          console.log(
            `[pet-asset-isolation] 已从产物移除 ${dir.name}（${dir.files} 个文件 / ${dir.bytes} B）`,
          )
        }
        if (result.removed.length === 0) {
          console.log('[pet-asset-isolation] 产物里没有桌宠静态资产（无需裁剪）')
        }
      },
    },
  }
}

/**
 * 后端 Controller 的 @RequestMapping 前缀清单。
 *
 * 新增模块时只需在此追加一项，不必再重复书写 target / changeOrigin。
 * 注意：路径为「前缀匹配」，更长的前缀必须排在更短的前面，
 * 否则 '/interaction' 会先匹配并吞掉 '/interaction-status'。
 */
const API_PREFIXES = [
  '/a',
  '/agent',
  '/api',
  '/checklist',
  '/config',
  '/email',
  '/execution',
  '/interaction-status',
  '/interaction',
  '/log',
  '/mcp',
  '/model',
  '/personalization',
  '/provider',
  '/sandbox',
  '/session',
  '/settings',
  '/skill',
  '/task',
  '/team',
  '/tool-call',
  '/tools',
  '/workspace',
] as const

const proxy = Object.fromEntries(
  API_PREFIXES.map((prefix) => [prefix, { target: url, changeOrigin: true }]),
)

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [vue(), petAssetIsolation()],
  build: {
    rollupOptions: {
      /**
       * 双入口：主应用 + 自绘通知窗口。
       *
       * <p>通知窗口必须是独立页面，不能复用 index.html —— 复用它会把整套 Vue 应用
       * 连同 pinia、路由、API 拦截器一起启动。而通知窗口只需要渲染一张卡片，
       * 且它跑在 `focusable: false` 的置顶小窗里，任何多余初始化都会拖慢首帧。</p>
       *
       * <p><b>桌宠入口（pet.html）已从生产构建入口移除</b>（M1/T01）：生产构建只有主应用与
       * 自绘通知窗口两个入口，桌宠目前只在开发链可见，安装版不得出现桌宠入口。
       * 它原本还因为"常驻不关、再拖一整套 Vue 会白占几十兆内存"
       * 而独立成页 —— 那条理由仍然成立，所以 dev 侧仍走独立入口，只是不再进 `dist`：
       * `npm run dev:pet` 用 `vite.pet.config.ts`（root 相同、端口独立 5275、`appType: 'mpa'`），
       * 开发时不依赖本文件的 `input`。</p>
       *
       * <p>守卫：`node scripts/check-pet-not-shipped.mjs`（进 `npm run test:pet` 与 CI）
       * 会断言这里没有 `pet` 键、且 `dist` 里没有 `pet.html` 与桌宠指纹。</p>
       *
       * <p><b>静态资产也要隔离（M2 线A任务 2）：</b>`public/live2d/` 下全是桌宠资产，
       * 而 `publicDir` 会被整目录拷进 `dist/` ⇒ 安装版白胖约 9 MiB。所以 plugins 里挂了
       * {@link petAssetIsolation}，在构建尾巴上裁掉 `dist/live2d/pet-*`。
       * 它**只作用于 build**（`apply: 'build'`），开发态（5275 dev server、electron 的
       * `lxa://` extraBases、`pet.html` 的资产加载）一个字节都不变。</p>
       */
      input: {
        main: resolve(__dirname, 'index.html'),
        notification: resolve(__dirname, 'notification.html'),
      },
    },
  },
  server: {
    port: 5174,
    // Electron 验证产物含独占缓存文件，监听它们会导致开发服务器退出。
    watch: { ignored: ['**/.run/**'] },
    proxy,
    /**
     * 关闭热更新：改文件不再自动热替换或整页刷新，必须手动 Ctrl+R 才能看到新代码。
     *
     * <p>Vite 的 full-reload 也走 HMR 通道，所以 {@code hmr: false} 会把两者一起停掉；
     * 生产构建不受影响。</p>
     */
    hmr: false,
  },
})
