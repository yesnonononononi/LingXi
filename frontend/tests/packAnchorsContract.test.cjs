const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 扩展包锚点「文档 ↔ 代码」同步用例。
 *
 * <p><b>守护的缺陷：</b>开放文档曾把 <span>`aside.border-r`</span> 当作侧边栏锚点写进示例——
 * 那是 Tailwind 原子类，只是「全应用恰好唯一」，不是契约。扩展包作者只能靠翻源码确认哪些选择器
 * 真的稳定，等于文档没法独立支撑开发。现在两侧都锁在 `data-slot` 上，本用例机械校验：</p>
 * <ol>
 *   <li>文档里出现的每个 <span>`data-slot`</span> 锚点都必须真的存在于源码；</li>
 *   <li>源码里约定的锚点必须在文档里写出来——否则作者又会退回去翻源码。</li>
 * </ol>
 * 任意一侧单独改动都会变红。
 */

const FRONTEND_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(FRONTEND_ROOT, 'src');
const GUIDE_PATH = path.join(FRONTEND_ROOT, 'public', 'docs', 'extension-packs-guide.html');

/** 契约锚点 -> 承载它的组件文件。新增锚点必须同时登记在这里。 */
const CONTRACT_ANCHORS = {
  sidebar: 'src/components/chat/Sidebar.vue',
  'sidebar-footer-bar': 'src/components/chat/Sidebar.vue',
  'sidebar-footer': 'src/components/chat/SidebarFooterBar.vue',
  'workspace-tree': 'src/components/chat/SidebarWorkspaceTree.vue',
  'workspace-group': 'src/components/chat/SidebarWorkspaceTree.vue',
  'pinned-group': 'src/components/chat/SidebarWorkspaceTree.vue',
  'session-row': 'src/components/chat/SidebarSessionRow.vue',
  'chat-input-card': 'src/components/chat/ChatInputArea.vue',
  'tree-menu': 'src/components/common/BranchedMenu.vue',
  'tree-section': 'src/components/common/BranchedMenu.vue',
  'tree-row': 'src/components/common/BranchedMenu.vue',
};

function readText(relPath) {
  return fs.readFileSync(path.resolve(FRONTEND_ROOT, relPath), 'utf8');
}

test('每个契约锚点都真实存在于源码中', () => {
  for (const [anchor, relFile] of Object.entries(CONTRACT_ANCHORS)) {
    const source = readText(relFile);
    assert.ok(
      source.includes(`data-slot="${anchor}"`),
      `${relFile} 里找不到 data-slot="${anchor}"：锚点是扩展包唯一可依赖的接口，删掉等于破坏契约`,
    );
  }
});

test('契约锚点在开放文档里全部写出来', () => {
  const guide = readText('public/docs/extension-packs-guide.html');
  const missing = Object.keys(CONTRACT_ANCHORS).filter(anchor => !guide.includes(`data-slot="${anchor}"`));
  assert.deepEqual(
    missing,
    [],
    `以下锚点在源码里存在但文档没写，扩展包作者只能回去翻源码：${missing.join(', ')}`,
  );
});

test('文档里提到的 data-slot 锚点必须真的存在，避免文档写了个不存在的选择器', () => {
  const guide = readText('public/docs/extension-packs-guide.html');
  const documented = new Set([...guide.matchAll(/data-slot=["']([a-z-]+)["']/g)].map(m => m[1]));
  assert.ok(documented.size >= Object.keys(CONTRACT_ANCHORS).length, '文档里的锚点数量不应少于契约表');

  const known = new Set(Object.keys(CONTRACT_ANCHORS));
  const unknown = [...documented].filter(anchor => !known.has(anchor));
  assert.deepEqual(
    unknown,
    [],
    `文档写出了契约表之外的锚点（要么补进 CONTRACT_ANCHORS，要么从文档删掉）：${unknown.join(', ')}`,
  );
});

test('文档页的 DOCS 数据能解析，且锚点契约页已接线', () => {
  const html = readText('public/docs/extension-packs-guide.html');
  const start = html.indexOf('var DOCS =');
  assert.ok(start > -1, '文档页里找不到 var DOCS 定义');

  const objStart = html.indexOf('{', start);
  // 用「DOCS 之后的第一条语句」作右边界：靠大括号计数会被示例代码里的 { canvas, surface }
  // 这类字符串内容骗到，直接切片更稳。
  const objEnd = html.indexOf('var contentEl', objStart);
  assert.ok(objEnd > objStart, '未能定位 DOCS 字面量的结束位置');
  const literal = html
    .slice(objStart, objEnd)
    .trim()
    .replace(/;$/, '');

  let docs;
  assert.doesNotThrow(() => {
    // 文档页自己就是这么求值的，这里只验证字面量语法，不执行页面脚本
    docs = new Function(`return (${literal});`)();
  }, 'DOCS 字面量语法错误：扩展包文档会在打开时整页白屏');

  assert.ok(docs['anchor-contract'], '缺少 anchor-contract 页面，锚点契约无从查起');
  assert.ok(docs['cat-sidebar'], '缺少 cat-sidebar 页面');

  // 导航里必须有入口，否则页面存在也点不到
  assert.match(
    html,
    /data-doc="anchor-contract"/,
    '锚点契约页没有导航入口，等于不存在',
  );
});

test('侧边栏类目文档不再把 aside.border-r 当作锚点教学', () => {
  const guide = readText('public/docs/extension-packs-guide.html');
  const block = guide.slice(guide.indexOf("'cat-sidebar'"), guide.indexOf("'cat-input'"));
  assert.ok(block.length > 0, '未能定位到侧边栏类目文档块');
  assert.ok(
    block.includes('aside[data-slot=&quot;sidebar&quot;]') || block.includes('aside[data-slot="sidebar"]'),
    '侧边栏类目示例必须使用契约锚点 aside[data-slot="sidebar"]',
  );
  const pres = [...block.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map(m => m[1]);
  assert.ok(pres.length > 0, '侧边栏类目文档缺少样式示例');
  for (const pre of pres) {
    assert.equal(
      /aside\.border-r/.test(pre),
      false,
      '侧边栏示例仍在教 aside.border-r：那是原子类而非契约，重构换名就会失效',
    );
  }
});
