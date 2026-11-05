import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import { check } from './check.mjs';

const root = new URL('../', import.meta.url);
const baseSit = readPng(fileURLToPath(new URL('../../../poses/sit/source/sit_neutral_native.png', import.meta.url)));

test('正式交付物通过像素、锚点轮廓、两倍母版、GIF 时序校验', () => {
  assert.deepEqual(check().problems, []);
});

test('回退成睁眼原图必须失败，即使清单文件摘要仍正确', () => {
  const problems = check({ imageOverrides: { 'frames/sit_blink_native.png': baseSit } }).problems;
  assert(problems.some(message => message.includes('缺少真实状态变化')));
  assert(problems.some(message => message.includes('闭眼帧仍有明显虹膜')));
});

test('区域外坏点与 alpha 漂移必须分别失败', () => {
  const image = readPng(fileURLToPath(new URL('frames/sit_blink_native.png', root)));
  image.data[0] = 255; image.data[3] = 255;
  const problems = check({ imageOverrides: { 'frames/sit_blink_native.png': image } }).problems;
  assert(problems.some(message => message.includes('指定区域外像素改变')));
  assert(problems.some(message => message.includes('轮廓或透明度改变')));
});

test('玩耍删除回应阶段必须失败', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'));
  manifest.clips.play_cloud.steps = manifest.clips.play_cloud.steps.filter(step => step.phase !== 'response');
  assert(check({ manifestOverride: manifest }).problems.includes('玩耍缺少四段闭环'));
});

test('GIF 改成不清帧必须失败，守住透明动画残影', () => {
  const bytes = Buffer.from(fs.readFileSync(new URL('gifs/sit_blink.gif', root)));
  const control = bytes.indexOf(Buffer.from([0x21, 0xf9, 4, 9]));
  assert(control > 0);
  bytes[control + 3] = 5;
  assert(check({ gifOverrides: { sit_blink: bytes } }).problems.some(message => message.includes('清帧或透明配置错误')));
});
