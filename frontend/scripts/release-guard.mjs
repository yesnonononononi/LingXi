#!/usr/bin/env node
/**
 * 发布入口守卫。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么要有这个文件（不要删）
 * ────────────────────────────────────────────────────────────────
 * 历史上 `app:release` 直接跑 `electron-builder --publish always`，于是存在
 * 「第二套发布事实」：它会跳过
 *   - 签名声明生成（scripts/sign-update.mjs，产出 Release 正文里的 lx-update 块）
 *   - 「先建 draft → 资产齐 → 校验摘要 → 再公开」的顺序
 * 一旦有人本地跑了它，就会发出一个**没有签名声明、或资产可见性存在空窗**的
 * Release —— 而客户端内置公钥要求验签，这类 Release 会让所有客户端拒绝更新，
 * 且因为发布已发生，补救代价很高。
 *
 * 因此正式发布只能有一条通道：GitHub Actions 的 Release 工作流
 * （.github/workflows/release.yml）。本脚本负责把本地入口拦下来，并提示正确做法。
 *
 * 本地仍可构建用于自测：
 *   npm run app:build        # 产出 nsis，--publish never
 */

const VERSION_CMD = 'npm run app:build';

console.error(`
❌ 本地不允许直接发布 Release。

   正式发布只有一条通道：GitHub Actions → Release 工作流。
   请在仓库 Actions 页面手动触发 "Release" 工作流，并按提示输入版本号。

   为什么本地发布被禁用：
     · 本地 --publish always 会跳过 lx-update 签名声明生成，
       产出的 Release 会让所有客户端验签失败、拒绝更新；
     · 本地发布无法保证「draft → 资产齐备 → 再公开」的顺序，
       存在 latest.yml 与二进制不同步可见的空窗。

   如果你只是想本地构建一个安装包自测，请用：
     ${VERSION_CMD}
`);

process.exit(1);
