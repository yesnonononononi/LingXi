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

test('Windows 产品 ICO 各条目尺寸与 PNG 一致，覆盖任务栏和安装包尺寸', () => {
  const icon = fs.readFileSync(path.join(__dirname, '../electron/resources/icon.ico'));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  const count = icon.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const width = icon[entry] || 256;
    const height = icon[entry + 1] || 256;
    const length = icon.readUInt32LE(entry + 8);
    const offset = icon.readUInt32LE(entry + 12);
    const png = icon.subarray(offset, offset + length);
    assert.equal(png.length, length);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    sizes.push(width);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '../electron/resources/icon.png')),
    fs.readFileSync(path.join(__dirname, '../src/assets/lingxi-agent-logo.png')));
});

test('桌面窗口直接使用产品 PNG，避免运行时依赖 ICO 解码', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.match(main, /const iconPath = path\.join\(__dirname, 'resources\/icon\.png'\)/);
  assert.match(main, /icon: iconPath/);
  assert.equal(packageConfig.build.win.icon, 'electron/resources/icon.ico');
});

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
