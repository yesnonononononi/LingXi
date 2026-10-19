import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPetSvg, FACES_IN_SVG, FACE_GROUP_PREFIX, PET_VIEWBOX } from '../src/pet.mjs';

const svg = buildPetSvg();

test('SVG 根节点带正确的 viewBox 与初始状态', () => {
  assert.match(svg, new RegExp(`viewBox="0 0 ${PET_VIEWBOX.width} ${PET_VIEWBOX.height}"`));
  assert.match(svg, /data-face="normal"/);
  assert.match(svg, /data-action="idle"/);
});

test('每个表情都有对应的 group', () => {
  for (const face of FACES_IN_SVG) {
    assert.ok(
      svg.includes(`id="${FACE_GROUP_PREFIX}${face}"`),
      `缺少表情 group: ${face}`,
    );
  }
});

test('表情 group 数量与声明一致，没有多余手工残留', () => {
  const found = svg.match(/class="pet-face"/g) ?? [];
  assert.equal(found.length, FACES_IN_SVG.length);
});

test('表情 group 内含实际图形，不是空壳', () => {
  for (const face of FACES_IN_SVG) {
    const start = svg.indexOf(`id="${FACE_GROUP_PREFIX}${face}"`);
    const end = svg.indexOf('</g>', start);
    const body = svg.slice(start, end);
    assert.match(body, /<(path|ellipse|circle)\b/, `表情 ${face} 里没有任何图形`);
  }
});

test('所有 id 唯一，避免 CSS 选择器切错脸', () => {
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length, `存在重复 id: ${ids.join(',')}`);
});

test('标签成对闭合', () => {
  const opens = (svg.match(/<g\b/g) ?? []).length;
  const closes = (svg.match(/<\/g>/g) ?? []).length;
  assert.equal(opens, closes);

  const svgOpen = (svg.match(/<svg\b/g) ?? []).length;
  const svgClose = (svg.match(/<\/svg>/g) ?? []).length;
  assert.equal(svgOpen, 1);
  assert.equal(svgClose, 1);
});

test('关键部件都在（尾巴 / 耳朵 / 蝴蝶结 / 呆毛 / 脸裁剪）', () => {
  assert.match(svg, /id="pet-tail"/);
  assert.match(svg, /id="pet-ribbon"/);
  assert.match(svg, /id="pet-body-root"/);
  assert.match(svg, /clipPath id="petFaceClip"/);
  assert.match(svg, /clip-path="url\(#petFaceClip\)"/);
});

test('主色全部走 CSS 变量，没有硬编码到 SVG 里', () => {
  // 允许硬编码的只有：高光白、腮红加深、舌头/星星/怒气记号这类点缀色
  const fills = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((match) => match[1]);
  const hardcoded = fills.filter(
    (value) => !value.startsWith('var(') && !value.startsWith('url(') && value !== 'none',
  );

  for (const value of hardcoded) {
    assert.match(value, /^#[0-9A-Fa-f]{6}$/, `存在非法的颜色值: ${value}`);
  }

  // 主色一旦被写死，换 palette 就会失效——这是最容易偷偷回归的地方
  const forbidden = ['#FDFBF8', '#E9E2DC', '#FDF1E9', '#EBDFD9', '#A9C3DF', '#7FA6CC'];
  for (const value of hardcoded) {
    assert.ok(
      !forbidden.includes(value.toUpperCase()),
      `主色 ${value} 被写死在 SVG 里，应改用 var(--pet-*)`,
    );
  }
});

