/**
 * ⚠️ 本文件是「墓碑」，不是配置。
 *
 * 项目用的是 Tailwind v4，`src/style.css` 首行是 `@import "tailwindcss"` 且**没有** `@config` 指令，
 * 所以 v4 根本不读这个文件 —— 这里写什么都不会进入编译结果。
 * 曾经的 `theme.extend.colors.gray[950] / indigo[650]` 就是这样变成死配置的：
 * 全仓对这两个色阶的引用数为 0（已实测 grep），即使写了也生成不出对应工具类。
 *
 * 需要改主题映射请去 `src/style.css` 的 `@theme inline` 块；
 * 需要加令牌请去 `src/theme/tokens.css`（定义）与 `src/theme/tokens.ts`（元数据）。
 *
 * 保留空导出而非直接删文件：万一外部工具链/脚本按路径 import 它，删掉会变成硬报错。
 */
export default {};

