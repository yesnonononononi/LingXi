const path = require('node:path');
const fs = require('node:fs');

/** 只检查部署说明和后端产物；目标环境依赖不能通过文件名推断可用。 */
module.exports = async function verifySandboxBundle(context) {
  const { verifyRuntime } = await import('./build-sandbox-runtime.mjs');
  const root = context.packager.projectDir;
  verifyRuntime(path.join(root, 'build/runtime'), context.electronPlatformName);
  if (!fs.existsSync(path.join(root, 'build/backend/app.jar'))) throw new Error('缺少本次后端构建产物');
};
