'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Platform } = require('app-builder-lib');
const { createElectronFrameworkSupport } = require('app-builder-lib/out/electron/ElectronFramework');
const electronGet = require('app-builder-lib/out/util/electronGet');
const packageConfig = require('../package.json');
const electronVersion = require('electron/package.json').version;

async function createProbe(t, overrides = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const projectDir = fs.mkdtempSync(path.join(temporaryRoot, 'lingxi-electron-'));
  t.after(() => {
    const relativePath = path.relative(temporaryRoot, projectDir);
    assert.ok(relativePath.startsWith('lingxi-electron-') && !relativePath.includes(path.sep));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
  const electronDir = path.join(projectDir, 'node_modules', 'electron');
  fs.mkdirSync(electronDir, { recursive: true });
  fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ version: electronVersion }));
  const appOutDir = path.join(projectDir, 'win-unpacked');
  const config = { ...structuredClone(packageConfig.build), ...overrides };
  const packager = {
    projectDir,
    config,
    platform: Platform.WINDOWS,
    appInfo: { type: packageConfig.type },
    info: { getWorkspaceRoot: async () => projectDir },
  };

  // 只替换网络与解压，分发源选择和版本解析必须执行打包器的真实实现。
  const downloadCalls = [];
  const originalDownload = electronGet.downloadElectronArtifactZip;
  const originalExtract = electronGet.extractArchive;
  t.after(() => {
    electronGet.downloadElectronArtifactZip = originalDownload;
    electronGet.extractArchive = originalExtract;
  });
  const archivePath = path.join(projectDir, 'electron.zip');
  electronGet.downloadElectronArtifactZip = async (options) => {
    downloadCalls.push(options);
    return archivePath;
  };
  electronGet.extractArchive = async (archive, destination) => {
    assert.equal(archive, archivePath);
    assert.equal(destination, appOutDir);
    fs.mkdirSync(appOutDir, { recursive: true });
    fs.writeFileSync(path.join(appOutDir, 'LICENSE'), 'Electron license fixture');
  };
  const framework = await createElectronFrameworkSupport(config, packager);
  return {
    projectDir,
    appOutDir,
    downloadCalls,
    prepare: () => framework.prepareApplicationStageDirectory({
      packager, appOutDir, platformName: 'win32', arch: 'x64', version: electronVersion,
    }),
  };
}

test('干净 npm 安装没有 electron/dist 时，实际打包器按已安装版本下载 Windows x64 二进制', async (t) => {
  const probe = await createProbe(t);
  assert.equal(fs.existsSync(path.join(probe.projectDir, 'node_modules', 'electron', 'dist')), false);
  await probe.prepare();
  assert.equal(probe.downloadCalls.length, 1);
  const options = probe.downloadCalls[0];
  assert.equal(options.version, electronVersion);
  assert.equal(options.platformName, 'win32');
  assert.equal(options.arch, 'x64');
  assert.equal(options.artifactName, 'electron');
  assert.equal(fs.readFileSync(path.join(probe.appOutDir, 'LICENSE.electron.txt'), 'utf8'),
    'Electron license fixture');
});

test('正对照：强制使用不存在的 electron/dist 会复现 CI 错误', async (t) => {
  const probe = await createProbe(t, { electronDist: 'node_modules/electron/dist' });
  await assert.rejects(probe.prepare(), /The specified electronDist does not exist/);
  assert.equal(probe.downloadCalls.length, 0);
});
