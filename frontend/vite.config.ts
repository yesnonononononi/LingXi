import {defineConfig} from 'vite'
import vue from '@vitejs/plugin-vue'
import {resolve} from 'node:path'

const url = 'http://localhost:8089'

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
  plugins: [vue()],
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
