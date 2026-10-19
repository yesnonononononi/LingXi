import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PALETTE, CSS_VARS } from '../src/palette.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesCss = fs.readFileSync(path.join(here, '..', 'src', 'styles.css'), 'utf8');

test('调色板全部是合法十六进制色值', () => {
  for (const [name, value] of Object.entries(PALETTE)) {
    assert.match(value, /^#[0-9A-Fa-f]{6}$/, `${name} 不是合法色值: ${value}`);
  }
});

test('CSS 变量表与调色板一一对应，没有漏项', () => {
  // 每个调色板颜色都必须有变量出口，否则新增色值会悄悄用不上
  assert.deepEqual(
    new Set(Object.values(CSS_VARS)),
    new Set(Object.values(PALETTE)),
    'CSS_VARS 与 PALETTE 的值集合不一致，两处已经漂移',
  );
});


test('styles.css 的 :root 默认值与调色板保持一致', () => {
  // CSS 里的兜底值会先于 JS 注入生效，两处不一致会出现「闪一下别的颜色」
  for (const [cssName, cssValue] of Object.entries(CSS_VARS)) {
    const match = stylesCss.match(new RegExp(`${cssName}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(match, `styles.css 缺少变量 ${cssName}`);
    assert.equal(
      match[1].toLowerCase(),
      cssValue.toLowerCase(),
      `styles.css 里 ${cssName} 与 palette.mjs 不一致`,
    );
  }
});
