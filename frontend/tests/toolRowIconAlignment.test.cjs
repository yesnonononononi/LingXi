const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 工具行「箭头列」必须恒定占位。
 *
 * <p>读文件没有详情，不渲染展开箭头；如果连占位也不留，那一行的图标会整体左移
 * 「箭头宽 + 行内 gap」，与可展开行的图标列对不齐（2026-10-20 截图实测：读取行图标
 * 比写入行偏左约 20px）。占位的尺寸必须与箭头一致，否则箭头改尺寸后又会歪。</p>
 */

const CASES = [
  {
    label: '主过程框工具行',
    file: '../src/components/chat/ProcessDetails.vue',
    // 锚点取箭头按钮本身，确保 region 起点就在箭头列
    anchor: 'canExpandTool(item.tool)" type="button"',
  },
  {
    label: '子会话抽屉工具行',
    file: '../src/components/chat/SubSessionDetailDrawer.vue',
    anchor: 'v-if="hasToolDetail(tc)"',
  },
];

for (const item of CASES) {
  test(`${item.label}：无详情时留箭头位，且占位尺寸与箭头一致`, () => {
    const source = fs.readFileSync(path.resolve(__dirname, item.file), 'utf8');
    const at = source.indexOf(item.anchor);

    // 金丝雀：锚点改名会导致下面全部正则落空、测试假绿，先证明区域定位有效
    assert.notEqual(at, -1, `锚点未命中：${item.anchor}（断言不成立，需同步更新本测试）`);

    // 窗口要盖住「箭头 → 占位」整段（主过程框那行 button 属性很长，实测约 720 字符）
    const region = source.slice(at, at + 1600);

    const arrowSize = /w-([\d.]+)\s+h-([\d.]+)/.exec(region);
    assert.notEqual(arrowSize, null, '箭头区域未解析到尺寸类，断言不成立');

    const placeholder = /<span v-else class="([^"]*)"[^>]*>\s*<\/span>/.exec(region);
    assert.notEqual(
      placeholder,
      null,
      '不可展开的行必须在箭头位置渲染等宽空占位，否则图标列会左移'
    );

    const placeholderClass = placeholder[1];
    assert.match(
      placeholderClass,
      new RegExp(`(^|\\s)w-${arrowSize[1].replace('.', '\\.')}(\\s|$)`),
      `占位宽度必须与箭头一致（箭头 w-${arrowSize[1]}）`
    );
    assert.match(
      placeholderClass,
      new RegExp(`(^|\\s)h-${arrowSize[2].replace('.', '\\.')}(\\s|$)`),
      `占位高度必须与箭头一致（箭头 h-${arrowSize[2]}）`
    );
  });
}
