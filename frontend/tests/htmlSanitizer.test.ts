import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SHOW_WITH_AGENT_HTML_CHARS,
  sanitizePageHtml,
  validateShowWithAgentHtml,
} from '../src/utils/htmlSanitizer.ts';

test('sanitizePageHtml 移除脚本、样式、注释、内联事件与 Base64 资源', () => {
  const raw = [
    '<html>',
    '<head>',
    '<style>.a { color: red; }</style>',
    '<script>console.log("xss")</script>',
    '</head>',
    '<body>',
    '<!-- hidden comment -->',
    '<noscript>enable js</noscript>',
    '<div onclick="alert(1)" class="card">Hello</div>',
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" />',
    '<svg viewBox="0 0 24 24"><path d="M1 1 L20 20"/></svg>',
    '</body>',
    '</html>',
  ].join('\n');

  const cleaned = sanitizePageHtml(raw);
  assert.equal(cleaned.includes('<script'), false);
  assert.equal(cleaned.includes('<style'), false);
  assert.equal(cleaned.includes('<noscript'), false);
  assert.equal(cleaned.includes('hidden comment'), false);
  assert.equal(cleaned.includes('onclick'), false);
  assert.equal(cleaned.includes('iVBORw0KGgo'), false);
  assert.equal(cleaned.includes('M1 1 L20 20'), false);
  assert.equal(cleaned.includes('data:base64-omitted'), true);
  assert.equal(cleaned.includes('<div class="card">Hello</div>'), true);
});

test('validateShowWithAgentHtml 在超过字符上限时拒绝，未超过时放行', () => {
  const ok = validateShowWithAgentHtml('<div>ok</div>');
  assert.equal(ok.valid, true);
  assert.equal(ok.limit, MAX_SHOW_WITH_AGENT_HTML_CHARS);

  const oversized = 'a'.repeat(MAX_SHOW_WITH_AGENT_HTML_CHARS + 1);
  const rejected = validateShowWithAgentHtml(oversized);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.charCount, MAX_SHOW_WITH_AGENT_HTML_CHARS + 1);
});
