import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {
  isLargePastedText,
  resolvePastedDocumentTitle,
  formatDocumentStat,
  createPastedDocument,
  composeMessageWithDocuments,
  LARGE_TEXT_MIN_CHARS,
  LARGE_TEXT_MIN_LINES,
} from '../src/utils/pastedDocument.js';

const requireCjs = createRequire(import.meta.url);
const harness = requireCjs('./support/chatProcessHarness.cjs') as {
  componentFromSrc: (relative: string, options?: Record<string, unknown>) => unknown;
  mountComponent: (t: unknown, component: unknown, props: Record<string, unknown>) => MemoryNode;
  findAll: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode[];
  find: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode | undefined;
};

interface MemoryNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  listeners: Record<string, Array<(event: unknown) => void>>;
  children: MemoryNode[];
}

test('isLargePastedText 判定规则', () => {
  // 1. 空值或短文本不判定为大文本
  assert.equal(isLargePastedText(''), false);
  assert.equal(isLargePastedText('hello world'), false);
  assert.equal(isLargePastedText('a'.repeat(LARGE_TEXT_MIN_CHARS - 1)), false);

  // 2. 超过字符数阈值（500 字符）判定为大文本
  assert.equal(isLargePastedText('a'.repeat(LARGE_TEXT_MIN_CHARS)), true);
  assert.equal(isLargePastedText('a'.repeat(1500)), true);

  // 3. 行数超过 15 行且字符数达到 200
  const fifteenShortLines = Array.from({ length: LARGE_TEXT_MIN_LINES }, (_, i) => `line ${i}: 1234567890`).join('\n');
  assert.ok(fifteenShortLines.length >= 200);
  assert.equal(isLargePastedText(fifteenShortLines), true);

  // 4. 行数多但字符数极少（如连续很多空行）不触发
  const manyEmptyLines = Array.from({ length: 20 }, () => ' ').join('\n');
  assert.equal(isLargePastedText(manyEmptyLines), false);
});

test('resolvePastedDocumentTitle 智能标题提取', () => {
  // 首行代码注释文件名
  assert.equal(
    resolvePastedDocumentTitle('// src/api/user.ts\nconst x = 1;\n'),
    'src/api/user.ts'
  );
  assert.equal(
    resolvePastedDocumentTitle('# script/deploy.py\nimport os\n'),
    'script/deploy.py'
  );

  // Markdown 标题
  assert.equal(
    resolvePastedDocumentTitle('# 系统设计规范说明\n正文内容...'),
    '系统设计规范说明'
  );

  // 首行如果只是括号标点，向下寻找有含义的文本
  assert.equal(
    resolvePastedDocumentTitle('{\n  "version": "1.0.0",\n  "name": "demo"\n}'),
    '"version": "1.0.0",'
  );

  // 空文本回退默认标题
  assert.equal(resolvePastedDocumentTitle('', '自定义文档'), '自定义文档');
});

test('formatDocumentStat 统计格式化', () => {
  assert.equal(formatDocumentStat({ charCount: 450, lineCount: 12 }), '450 字符 · 12 行');
  assert.equal(formatDocumentStat({ charCount: 1500, lineCount: 40 }), '1.5k 字符 · 40 行');
});

test('createPastedDocument 实体生成', () => {
  const content = '// test.ts\nconst a = 10;\nconst b = 20;';
  const doc = createPastedDocument(content, { id: 'test_doc_1' });
  assert.equal(doc.id, 'test_doc_1');
  assert.equal(doc.title, 'test.ts');
  assert.equal(doc.content, content);
  assert.equal(doc.charCount, content.length);
  assert.equal(doc.lineCount, 3);
});

test('composeMessageWithDocuments 组装发送文本', () => {
  const doc = createPastedDocument('console.log("hello");', { title: 'demo.js', id: 'd1' });

  // 1. 无文档时原样返回 trimmed 输入
  assert.equal(composeMessageWithDocuments('  hello lingxi  ', []), 'hello lingxi');

  // 2. 仅有文档无输入提示词
  const composedDocOnly = composeMessageWithDocuments('', [doc]);
  assert.ok(composedDocOnly.includes('[文档: demo.js]'));
  assert.ok(composedDocOnly.includes('```\nconsole.log("hello");\n```'));

  // 3. 同时有输入提示词与文档
  const composed = composeMessageWithDocuments('请帮我优化代码', [doc]);
  assert.ok(composed.startsWith('请帮我优化代码\n\n[文档: demo.js]'));

  // 4. 文档内含 ``` 时自动升档为 ```` 避免 Markdown 解析截断
  const markdownDoc = createPastedDocument('示例：\n```ts\nconst x = 1;\n```', { title: 'guide.md', id: 'd2' });
  const composedBackticks = composeMessageWithDocuments('', [markdownDoc]);
  assert.ok(composedBackticks.includes('````\n示例：\n```ts\nconst x = 1;\n```\n````'));
});

test('PastedDocumentCard 组件渲染与交互事件', t => {
  const CardComponent = harness.componentFromSrc('components/chat/PastedDocumentCard.vue');
  const doc = createPastedDocument('// src/index.ts\nconst server = createServer();\nserver.listen(3000);', {
    id: 'doc_card_test_1',
  });

  const emitted: Record<string, unknown[]> = {};
  const root = harness.mountComponent(t, CardComponent, {
    document: doc,
    isDark: true,
    onPreview: () => {
      emitted.preview = (emitted.preview || []).concat(true);
    },
    onExpand: () => {
      emitted.expand = (emitted.expand || []).concat(true);
    },
    onRemove: () => {
      emitted.remove = (emitted.remove || []).concat(true);
    },
  });

  // 1. 验证卡片成功渲染并展示标题
  const cardNode = harness.find(root, node => node.props['data-testid'] === 'pasted-document-card');
  assert.ok(cardNode, '卡片节点必须存在且具有 data-testid="pasted-document-card"');

  const titleNode = harness.find(root, node => node.text.includes('src/index.ts'));
  assert.ok(titleNode, '卡片必须显示文档标题 src/index.ts');

  // 2. 验证统计信息节点
  const statNode = harness.find(root, node => node.text.includes('字符') && node.text.includes('行'));
  assert.ok(statNode, '卡片必须展示统计信息（字符数与行数）');

  // 3. 触发操作按钮
  const buttons = harness.findAll(root, node => node.tag === 'button');
  assert.equal(buttons.length, 3, '卡片应包含预览、展开、删除 3 个按钮');

  const previewBtn = buttons.find(b => String(b.props?.title || '').includes('预览文档'));
  assert.ok(previewBtn && typeof previewBtn.props?.onClick === 'function', '预览按钮必须存在且可点击');
  (previewBtn.props.onClick as (e: unknown) => void)({ stopPropagation: () => {} });
  assert.equal(emitted.preview?.length, 1, '点击卡片必须触发 preview 事件');

  const expandBtn = buttons.find(b => String(b.props?.title || '').includes('转为纯文本'));
  assert.ok(expandBtn && typeof expandBtn.props?.onClick === 'function', '转为纯文本按钮必须存在且可点击');
  (expandBtn.props.onClick as (e: unknown) => void)({ stopPropagation: () => {} });
  assert.equal(emitted.expand?.length, 1, '点击展开按钮必须触发 expand 事件');

  const removeBtn = buttons.find(b => String(b.props?.title || '').includes('移除文档'));
  assert.ok(removeBtn && typeof removeBtn.props?.onClick === 'function', '移除文档按钮必须存在且可点击');
  (removeBtn.props.onClick as (e: unknown) => void)({ stopPropagation: () => {} });
  assert.equal(emitted.remove?.length, 1, '点击移除按钮必须触发 remove 事件');
});

test('PastedDocumentPreviewModal 弹窗渲染与事件触发', t => {
  const ModalComponent = harness.componentFromSrc('components/chat/PastedDocumentPreviewModal.vue');
  const doc = createPastedDocument('function add(a, b) {\n  return a + b;\n}', {
    title: 'math.js',
    id: 'doc_modal_test_1',
  });

  const emitted: Record<string, unknown[]> = {};
  const root = harness.mountComponent(t, ModalComponent, {
    open: true,
    document: doc,
    isDark: false,
    onClose: () => {
      emitted.close = (emitted.close || []).concat(true);
    },
    onExpand: () => {
      emitted.expand = (emitted.expand || []).concat(true);
    },
  });

  // 1. 验证标题展示
  const titleNode = harness.find(root, node => node.text.includes('math.js'));
  assert.ok(titleNode, '弹窗内必须包含文档标题 math.js');

  // 2. 验证内容展示
  const preNode = harness.find(root, node => node.tag === 'pre' && node.text.includes('function add(a, b)'));
  assert.ok(preNode, '弹窗内必须包含 pre 节点展示文档内容');

  // 3. 点击转为纯文本按钮
  const buttons = harness.findAll(root, node => node.tag === 'button');
  const expandBtn = buttons.find(b => String(b.props?.title || '').includes('转为纯文本'));
  assert.ok(expandBtn && typeof expandBtn.props?.onClick === 'function', '转为纯文本按钮必须存在且可点击');
  (expandBtn.props.onClick as (e: unknown) => void)({ stopPropagation: () => {} });
  assert.equal(emitted.expand?.length, 1, '点击转为纯文本按钮必须触发 expand 事件');
});
