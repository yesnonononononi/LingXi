# AetherAgent Console（星辰智能体交互控制台）

LingXi 项目的前端控制台，基于 **Vue 3 + TypeScript + Vite + Tailwind CSS** 构建，用于与后端 AI Agent 服务进行交互。

## ✨ 功能特性

- **AI 对话**：基于 SSE 的流式响应，支持思维链（Thinking）展示、工具调用轨迹、任务计划（Plan）与执行结果回放
- **会话管理**：创建 / 重命名 / 删除会话，游标分页加载历史消息
- **工作空间**：创建、切换与删除工作空间，支持本地目录与容器内目录两种模式
- **模型管理**：模型列表、新增与编辑（模型名称、Base URL、API Key、供应商等）
- **审批交互**：`require_choice` 等需要用户确认的步骤渲染为审批卡片，可在界面中直接选择
- **消息交互**：分支切换、消息编辑、消息删除、停止生成
- **主题切换**：全局共享的深色 / 浅色主题（与登录页、模型页共用偏好）
- **安全渲染**：Markdown 渲染（`markdown-it`）+ 代码高亮（`highlight.js`）+ `DOMPurify` 防 XSS
- **登录认证**：JWT Token 认证，全局路由守卫控制访问权限

## 🛠 技术栈

| 类别 | 技术 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` SFC） |
| 语言 | TypeScript |
| 构建工具 | Vite |
| 样式 | Tailwind CSS |
| 路由 | Vue Router |
| HTTP | Axios + Fetch（SSE 流式请求） |
| 内容渲染 | markdown-it、highlight.js、DOMPurify |
| 动效 | GSAP、Motion |

## 📁 目录结构

```
frontend/
├── index.html                 # 应用入口 HTML
├── vite.config.ts             # Vite 配置（含后端代理）
├── tailwind.config.js         # Tailwind 配置
├── postcss.config.js          # PostCSS 配置
└── src/
    ├── main.ts                # 应用启动入口
    ├── App.vue                # 根组件
    ├── style.css              # 全局样式
    ├── assets/                # 静态资源
    ├── components/            # 通用与业务组件
    │   ├── chat/              # 聊天相关（消息、输入、计划、审批、工作空间等）
    │   ├── common/            # 通用组件（弹窗、下拉等）
    │   └── model/             # 模型配置面板
    ├── composables/           # 组合式函数（主题、确认等）
    ├── services/              # API 服务层
    │   ├── api.ts             # 统一 API 门面入口
    │   ├── interceptor.ts     # Axios 请求/响应拦截器
    │   ├── auth.ts            # 认证接口
    │   ├── agent.ts           # Agent 对话（含 SSE 流式）
    │   ├── chat.ts            # 会话/聊天聚合逻辑
    │   ├── model.ts           # 模型配置接口
    │   ├── session.ts         # 会话接口
    │   ├── workspace.ts       # 工作空间接口
    │   └── commonConfig.ts    # 通用配置接口
    ├── types/                 # TypeScript 类型定义
    ├── utils/                 # 工具函数（Markdown、会话解析等）
    └── views/                 # 页面视图
        ├── auth/              # 登录页
        ├── chat/              # 主聊天页
        ├── model/             # 模型列表 / 表单页
        └── settings/          # 设置弹窗
```

## 🚀 快速开始

### 环境要求

- **Node.js**：20.19+ 或 22.12+（Vite 7 要求）
- **npm / pnpm / yarn**：任选其一

### 安装依赖

```bash
cd frontend
npm install
```

### 启动开发服务器

```bash
npm run dev
```

默认在 <http://localhost:5174> 启动。

> **注意**：前端依赖后端服务提供接口。启动前请先确保后端已运行在 `http://localhost:8088`（可在 `vite.config.ts` 中修改代理目标）。

### 构建生产版本

```bash
npm run build
```

产物输出到 `dist/` 目录。

### 本地预览构建产物

```bash
npm run preview
```

## 🔧 开发说明

### 后端接口代理

开发环境下，`vite.config.ts` 通过代理将以下路径转发至后端服务（默认 `http://localhost:8088`）：

```
/auth      # 认证
/model     # 模型配置
/session   # 会话
/workspace # 工作空间
/config    # 通用配置
/agent     # Agent
/team      # 团队
/a         # Agent 对话（含 /a/completion、/a/completion/stream）
/api       # 其它接口
```

如需修改后端地址，请编辑 `vite.config.ts` 中对应 `proxy` 配置的 `target`。

### 认证说明

前端使用 `localStorage` 中的 `token` 进行鉴权（请求拦截器会自动附加 `Authorization: Bearer <token>`）。未登录访问受保护页面时，路由守卫会重定向至 `/login`。

### 流式对话

聊天接口 `/a/completion/stream` 使用 **SSE（Server-Sent Events）**，前端通过 `fetch` 读取流并逐条解析事件，支持以下事件类型（节选）：

- `AI_MESSAGE`：模型回复（含思维链与正文）
- `PLAN_UPDATE`：任务计划更新
- `TOOL_CALL` / `TOOL_RESULT`：工具调用与结果
- `REQUIRE_CHOICE`：需要用户确认 / 选择
- `EXECUTION_COMPLETED` / `EXECUTION_FAILED` / `EXECUTION_CANCELLED`：执行结束状态

## 📚 相关文档

- [Vue 3 官方文档](https://vuejs.org/)
- [Vite 官方文档](https://vite.dev/)
- [Tailwind CSS 官方文档](https://tailwindcss.com/)
- [TypeScript 官方文档](https://www.typescriptlang.org/)

后端服务请参见项目根目录的 Spring Boot 工程。
