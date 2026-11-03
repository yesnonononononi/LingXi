const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fs, path, root } = require('./common.cjs');

const P0_SHA256 = '29fbbbda445b852c320f9b8181f43a5117788ab9a957d685259c46fd9a06f6e8';
const referencePath = path.resolve(root, '../../work/desktop-pet-visual/docs/assets/desktop-pet/v3/front-standing.png');
const supportLayers = [
  { id: 'underpainting', file: 'support/underpainting.png', purpose: '被移开部件下的头发补绘底层' },
  { id: 'body-occluder', file: 'support/body-occluder.png', purpose: '保留前发、衣物和面部的主体遮挡层' },
  { id: 'foreground-occluder', file: 'support/foreground-occluder.png', purpose: '遮住隐藏发根及蝴蝶结局部的前景盖片' },
];

function readRequired(file, readBytes = fs.readFileSync) {
  try { return readBytes(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`必需美术资源缺失: file=${file}`, { cause: error });
    throw error;
  }
}

function checkReference(reference, readBytes = fs.readFileSync) {
  assert.equal(reference.sha256, P0_SHA256, 'P0 基准摘要未锁定，不能使用占位值或随文件重算');
  const bytes = readRequired(reference.path, readBytes);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(actual, P0_SHA256, 'P0 立绘内容已改变，必须先重新确认美术基准');
  return actual;
}

function checkRegisteredAsset(record, readBytes = fs.readFileSync) {
  assert.equal(record.width, 2048, `资源清单宽度错误: file=${record.file}`);
  assert.equal(record.height, 3072, `资源清单高度错误: file=${record.file}`);
  assert.match(record.sha256, /^[a-f0-9]{64}$/, `资源摘要缺失或格式错误: file=${record.file}`);
  const bytes = readRequired(path.join(root, record.file), readBytes);
  assert.ok(bytes.length >= 33 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', `PNG 签名错误: file=${record.file}`);
  assert.equal(bytes.readUInt32BE(16), record.width, `实际宽度与清单不一致: file=${record.file}`);
  assert.equal(bytes.readUInt32BE(20), record.height, `实际高度与清单不一致: file=${record.file}`);
  assert.equal(bytes[24], 8, `资源不是 8bit: file=${record.file}`);
  assert.equal(bytes[25], 6, `资源不是 RGBA: file=${record.file}`);
  assert.equal(bytes.length, record.bytes, `资源体积与清单不一致: file=${record.file}`);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.sha256, `资源摘要不一致: file=${record.file}`);
  return bytes;
}

module.exports = { P0_SHA256, referencePath, supportLayers, checkReference, checkRegisteredAsset };
