const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');

function loadDependency(name) {
  const locations = [root, path.resolve(root, '../../tmp/pet-art-tools'),
    path.resolve(root, '../../work/desktop-pet-visual/frontend')];
  for (const location of locations) {
    try {
      const dependency = require(require.resolve(name, { paths: [location] }));
      if (name === 'ag-psd') dependency.initializeCanvas(
        () => { throw new Error('PSD 校验只使用原始像素，不应创建 Canvas'); },
        (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
      return dependency;
    }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error(`缺少资源处理依赖 ${name}，请在资源目录执行 npm install`);
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
}

const expressions = [
  ['E1_default', 'neutral', '默认'], ['E2_blink', 'blink', '眨眼'],
  ['E3_surprised', 'surprised', '惊讶'], ['E4_sad', 'sad', '委屈'],
  ['E5_angry', 'angry', '生气'], ['E6_shy', 'shy', '害羞'],
  ['E7_happy', 'happy', '开心'], ['E8_sleepy', 'sleepy', '困倦'],
];

module.exports = { fs, path, root, loadDependency, writeJson, hash, expressions };
