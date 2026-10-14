const path = require('node:path');
const fs = require('node:fs');

/** 所有 electron-builder 入口都经过检查，防止快速打包漏掉运行资源。 */
module.exports = async function verifySandboxBundle(context) {
  const { verifyRuntime } = await import('./build-sandbox-runtime.mjs');
  const root = context.packager.projectDir;
  const { Arch } = require('builder-util');
  verifyRuntime(path.join(root, 'build', 'runtime'), context.electronPlatformName, Arch[context.arch]);
  const helpers = path.join(root, 'build', 'sandbox-helpers');
  for (const name of ['exists.mjs', 'mkdir.mjs', 'deleteFile.mjs', 'readFile.mjs', 'writeFile.mjs',
    'executeCommand.mjs', 'request.mjs', 'srtCli.mjs', 'probe.mjs']) {
    if (!fs.existsSync(path.join(helpers, name))) throw new Error(`打包缺少框架 helper，请先运行 backend:runtime: ${name}`);
  }
};
