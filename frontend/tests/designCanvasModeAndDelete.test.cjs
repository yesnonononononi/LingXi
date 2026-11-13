/**
 * 设计原型预览（DesignCanvasPreview）门禁测试：
 * 验证模式手动切换（设计模式 vs 交互模式）、元素删除保护逻辑、撤销栈支持及按键防误触保护。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.resolve(__dirname, '../src/components/chat/DesignCanvasPreview.vue');
const I18N_FILE = path.resolve(__dirname, '../src/i18n/messages.ts');

const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const read = (file) => {
  assert.equal(fs.existsSync(file), true, `未找到文件：${file}`);
  return stripComments(fs.readFileSync(file, 'utf8'));
};

test('P1 模式切换机制：设计模式与交互模式状态及切换入口', () => {
  const code = read(FILE);
  assert.match(code, /canvasMode\s*=\s*ref<CanvasMode>/, '缺少 canvasMode 模式状态');
  assert.match(code, /setCanvasMode/, '缺少 setCanvasMode 模式切换函数');
  assert.match(code, /'design'/, '缺少 design 模式定义');
  assert.match(code, /'interactive'/, '缺少 interactive 模式定义');
  assert.match(code, /class="mode-switch"/, '模板中缺少 mode-switch 切换控件');
  assert.match(code, /setCanvasMode\('design'\)/, '缺少切至设计模式的触发');
  assert.match(code, /setCanvasMode\('interactive'\)/, '缺少切至交互模式的触发');
});

test('P2 交互解耦：交互模式下必须放行原生点击与双击事件', () => {
  const code = read(FILE);
  assert.match(
    code,
    /doc\.addEventListener\('click'[\s\S]*?if\s*\(\s*canvasMode\.value\s*!==\s*'design'\s*\)\s*return;/,
    'click 事件未在交互模式下放行'
  );
  assert.match(
    code,
    /doc\.addEventListener\('dblclick'[\s\S]*?if\s*\(\s*canvasMode\.value\s*!==\s*'design'\s*\)\s*return;/,
    'dblclick 事件未在交互模式下放行'
  );
});

test('P3 元素删除能力与边界安全防御', () => {
  const code = read(FILE);
  assert.match(code, /const\s+deleteSelectedElement\s*=/, '缺少 deleteSelectedElement 方法');
  assert.match(code, /HTML/, '删除未对 HTML 根标签进行保护');
  assert.match(code, /BODY/, '删除未对 BODY 根标签进行保护');
  assert.match(code, /el\.remove\(\)/, '缺少 el.remove() 真实删除调用');
  assert.match(code, /moveableInstance\.target\s*=\s*\[\]/, '删除后未清空 Moveable 选中目标');
  assert.match(code, /btn-delete-element/, '模板中缺少删除按钮 btn-delete-element');
});

test('P4 键盘按键监听与输入保护', () => {
  const code = read(FILE);
  assert.match(code, /e\.key\s*===\s*'Delete'\s*\|\|\s*e\.key\s*===\s*'Backspace'/, '缺少 Delete/Backspace 快捷键绑定');
  assert.match(code, /if\s*\(\s*isEditingText\.value\s*\)\s*return;/, '编辑文字时缺少删除拦截保护');
  assert.match(code, /INPUT|TEXTAREA|isContentEditable/, '在原生输入框中输入时缺少快捷键拦截保护');
});

test('P5 撤销重做（Undo / Redo）历史栈与操作安全闭环', () => {
  const code = read(FILE);
  assert.match(code, /undoStack\s*=\s*ref<string\[\]>/, '缺少 undoStack 撤销栈');
  assert.match(code, /redoStack\s*=\s*ref<string\[\]>/, '缺少 redoStack 重做栈');
  assert.match(code, /recordSnapshot/, '缺少 recordSnapshot 快照保存函数');
  assert.match(code, /const\s+undo\s*=/, '缺少 undo 撤销实现');
  assert.match(code, /const\s+redo\s*=/, '缺少 redo 重做实现');
  assert.match(
    code,
    /deleteSelectedElement[\s\S]*?recordSnapshot\(\)[\s\S]*?el\.remove\(\)/,
    '删除操作执行前未记录撤销快照'
  );
  assert.match(code, /moveableInstance\.on\('dragStart',\s*\(\)\s*=>\s*recordSnapshot\(\)\)/, '拖拽前未记录撤销快照');
});

test('P6 i18n 完整性检查：设计原型 preview 字典覆盖', () => {
  const i18n = read(I18N_FILE);
  for (const key of ['modeDesign', 'modeInteractive', 'modeDesignHint', 'modeInteractiveHint', 'deleteElement', 'undo', 'redo']) {
    assert.match(i18n, new RegExp(`${key}:`), `messages.ts 缺少 i18n 键: ${key}`);
  }
});
