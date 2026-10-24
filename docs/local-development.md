# 本地开发数据隔离

IDE、`spring-boot:run` 等源码启动自动启用 `dev,local`，使用端口 8089。数据库、JSON 配置、技能、日志与沙箱状态分别位于项目 `.lingxi/development` 下。安装包使用端口 8088 和原有用户目录，两个环境可以同时运行。

首次初始化前退出安装版和 IDE 后端，在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Initialize-Development.ps1
```

脚本复制安装版数据库、图片、配置和技能，并核对数据库 SHA-256。开发副本只调整设置中的 `dataDir`、`skillDir`；模型、MCP、工作空间、会话等保持复制时的内容。已有开发目录不会被覆盖，后续两个环境各自修改各自的数据。

前端运行 `npm run dev` 或 `npm run app:dev`，通过 Vite 连接 8089。源码桌面客户端拥有独立 userData 和单实例锁，只连接 IDE 开发后端，不自动运行 `target` 中可能过期的 jar。

`local` 是本地专用档位，不能给安装包追加该档位。若需指定不同的开发根目录，设置 `lingxi.development.directory`；已经初始化的开发设置也需同步调整两项目录值。
