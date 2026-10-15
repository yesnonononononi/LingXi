const path = require('node:path');
const fs = require('node:fs');

/**
 * 打包前闸门：断言随包资源真的齐了。
 * 走一遍与 sandbox:runtime 相同的校验（部署说明 + node/git bash/srt cli/mxc sdk），
 * 这样 app:builder:quick 这类跳过 staging 的入口不会静默发出缺组件的安装包。
 */
module.exports = async function verifySandboxBundle(context) {
  const { verifyRuntime } = await import('./build-sandbox-runtime.mjs');
  const root = context.packager.projectDir;
  verifyRuntime(path.join(root, 'build/runtime'), context.electronPlatformName);
  if (!fs.existsSync(path.join(root, 'build/backend/app.jar'))) throw new Error('缺少本次后端构建产物');
};
