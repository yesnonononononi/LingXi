import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

const url = 'http://localhost:8088'

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
  '/config',
  '/email',
  '/interaction-status',
  '/interaction',
  '/mcp',
  '/model',
  '/sandbox',
  '/session',
  '/settings',
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
       */
      input: {
        main: resolve(__dirname, 'index.html'),
        notification: resolve(__dirname, 'notification.html'),
      },
    },
  },
  server: {
    port: 5174,
    proxy,
  },
})
