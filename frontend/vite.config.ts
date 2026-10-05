import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

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
  '/session',
  '/settings',
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
  server: {
    port: 5174,
    proxy,
  },
})
