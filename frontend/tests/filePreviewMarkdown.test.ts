import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMarkdownFile } from '../src/utils/filePreviewMarkdown.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('isMarkdownFile 仅识别 md 与 markdown 后缀（大小写不敏感）', () => {
  assert.equal(isMarkdownFile('README.md'), true);
  assert.equal(isMarkdownFile('docs/guide.markdown'), true);
  assert.equal(isMarkdownFile('CHANGELOG.MD'), true);
  assert.equal(isMarkdownFile('notes.MarkDown '), true);

  assert.equal(isMarkdownFile('index.ts'), false);
  assert.equal(isMarkdownFile('readme.txt'), false);
  assert.equal(isMarkdownFile('md'), false);
  assert.equal(isMarkdownFile('markdown.json'), false);
  assert.equal(isMarkdownFile(''), false);
  assert.equal(isMarkdownFile(null), false);
  assert.equal(isMarkdownFile(undefined), false);
});

test('FilePreviewPanel 接入 MarkdownRenderer 与预览/源码切换契约', () => {
  const panelSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/components/chat/FilePreviewPanel.vue'),
    'utf8'
  );
  assert.match(panelSrc, /import MarkdownRenderer from '\.\/MarkdownRenderer\.vue';/);
  assert.match(panelSrc, /data-testid="file-markdown-preview"/);
  assert.match(panelSrc, /data-testid="file-preview-markdown-btn"/);
  assert.match(panelSrc, /data-testid="file-preview-source-btn"/);
  assert.match(panelSrc, /<MarkdownRenderer[\s\S]*?:content="active\.data\.content"[\s\S]*?:is-dark="isDark"/);
});
