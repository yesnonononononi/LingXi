import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {h, nextTick} from 'vue';

/**
 * 输入区「已选图片 → 点击缩略图看大图」守护用例（真实组件挂载）。
 *
 * <p>缺陷现场：输入框里选中的图片只显示 16px 缩略图 + 文件名，用户看不到原图。
 * 这里盯住四件事：</p>
 * <ol>
 *   <li>点击 chip 缩略图 → 预览对话框以 open 状态出现，且 `img[src]` 就是该附件的对象 URL；</li>
 *   <li>关闭按钮 / Esc / 点击遮罩都能关；</li>
 *   <li>预览中删除该附件 → 预览先关、对象 URL 才 revoke（顺序反了用户就看到裂图）；</li>
 *   <li>单一实现：输入区与消息气泡都复用 `common/ImageLightbox.vue`，不许各自再写一套 dialog。</li>
 * </ol>
 *
 * <p>为什么用组件挂载而不是 Electron 真 DOM：`AgentAPI.chatLimits()` 是选图前置条件，
 * 真渲染没有后端就永远 `canAttach=false`，用例只能靠桩才稳定。原生 dialog 的 UA 行为
 * （焦点陷阱 / Esc）由 `tests/messageImages.smoke.cjs` 在真 DOM 里覆盖，两层各管一段。</p>
 */

const requireCjs = createRequire(import.meta.url);

interface MemoryNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: MemoryNode[];
}

interface HarnessOptions {
  compileId?: string;
  extraStubs?: RegExp[];
  moduleStubs?: Array<{test: RegExp; exports: Record<string, unknown>}>;
}

const harness = requireCjs('./support/chatProcessHarness.cjs') as {
  componentFromSrc: (relative: string, options?: HarnessOptions) => unknown;
  mountComponent: (t: unknown, component: unknown, props: Record<string, unknown>) => MemoryNode;
  find: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode | undefined;
  findAll: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode[];
  readSource: (relativeFromTests: string) => string;
};

/** 用例期间被 revoke 的对象 URL（顺序即调用顺序）。 */
const revokedUrls: string[] = [];

/**
 * 装上最小 `document` / `URL` / `localStorage` / `Document` / `ShadowRoot` 替身。
 *
 * <p>文件级安装、`test.after` 还原：组件卸载钩子里的 `document.removeEventListener` 走的是
 * `t.after` 链，替身必须比它活得更久。</p>
 */
type DomStubScope = {
  document?: unknown; URL?: unknown; localStorage?: unknown; Document?: unknown; ShadowRoot?: unknown;
};
const domStubScope = globalThis as unknown as DomStubScope;
const previousDomStubs: DomStubScope = {
  document: domStubScope.document,
  URL: domStubScope.URL,
  localStorage: domStubScope.localStorage,
  Document: domStubScope.Document,
  ShadowRoot: domStubScope.ShadowRoot,
};
domStubScope.document = {addEventListener() {}, removeEventListener() {}};
domStubScope.URL = {
  createObjectURL: (file: File) => `blob:${file.name}`,
  revokeObjectURL: (url: string) => { revokedUrls.push(url); },
};
domStubScope.localStorage = {getItem: () => null, setItem() {}, removeItem() {}};
// Vue 3.5 的 v-model 指令会做 `rootNode instanceof Document`，Node 里没有这两个构造器。
domStubScope.Document = class DocumentStub {};
domStubScope.ShadowRoot = class ShadowRootStub {};

test.after(() => {
  for (const key of Object.keys(previousDomStubs) as Array<keyof DomStubScope>) {
    if (previousDomStubs[key] === undefined) delete domStubScope[key];
    else domStubScope[key] = previousDomStubs[key];
  }
});
/**
 * 挂载真实的 ChatInputArea。
 *
 * <p>`common/ImageLightbox.vue` 用模块桩换成它自己的真实实现：harness 对 `components/chat`
 * 之外的 `.vue` 默认走空壳桩，而本用例要观察的正是那个 dialog。</p>
 */
function mountInputArea(t: unknown): MemoryNode {
  // harness 的 Teleport 替身只透传 default 插槽，插槽被判为「稳定」后整棵子树不再更新 ——
  // 于是 `open` / `src` 的变化永远到不了 dialog。这里只在测试内存里摘掉 Teleport 外壳
  // （生产代码仍 Teleport 到 body），其余模板逐字保留。
  const lightboxSource = harness.readSource('../src/components/common/ImageLightbox.vue')
    .replace('<Teleport to="body">', '')
    .replace('</Teleport>', '');
  assert.ok(!lightboxSource.includes('Teleport'), '摘掉 Teleport 外壳失败：模板结构变了，请同步本用例');
  const lightbox = harness.componentFromSrc('components/common/ImageLightbox.vue', {
    compileId: 'image-lightbox-under-test',
    sourceOverrides: [{test: /common[/\\]ImageLightbox\.vue$/, source: lightboxSource}],
  });
  const component = harness.componentFromSrc('components/chat/ChatInputArea.vue', {
    compileId: 'chat-input-image-preview',
    extraStubs: [/ChatInputModelSelector\.vue$/, /ChatInputContextUsage\.vue$/],
    moduleStubs: [
      {test: /common[/\\]ImageLightbox\.vue$/, exports: {__esModule: true, default: lightbox}},
      {
        test: /ChatInputSendButton\.vue$/,
        exports: {
          __esModule: true,
          default: {
            props: ['isSending', 'armed', 'isDark', 'colors', 'onSend'],
            setup: () => () => h('button', {type: 'button', 'data-testid': 'chat-send-button'}),
          },
        },
      },
      {
        // 选图前置条件是 `AgentAPI.chatLimits()`：给一个真实上限，附件才加得进去。
        test: /services[/\\](interceptor|team|agent|skill)$/,
        exports: {
          default: {get: async () => ({code: 0, errMsg: 'stub'}), post: async () => ({code: 0, errMsg: 'stub'})},
          TeamAPI: {list: async () => ({code: 0, errMsg: 'stub'})},
          AgentAPI: {
            list: async () => ({code: 0, errMsg: 'stub'}),
            chatLimits: async () => ({code: 1, data: {maxImages: 9}}),
          },
          SkillAPI: {list: async () => ({code: 0, errMsg: 'stub'})},
        },
      },
      {
        // 星光粒子层：模板 ref 会调用 `ping()`，桩必须提供同名方法。
        test: /SparkTrail\.vue$/,
        exports: {
          __esModule: true,
          default: {setup: (_props: unknown, context: {expose: (api: object) => void}) => {
            context.expose({ping() {}});
            return () => null;
          }},
        },
      },
    ],
  });
  return harness.mountComponent(t, component, {isDark: false, hasActiveSession: true});
}

/** 等挂载期的异步（读图片上限 / 渲染刷新）落地。 */
async function flush(): Promise<void> {
  await nextTick();
  await new Promise<void>(resolve => { setTimeout(resolve, 0); });
  await nextTick();
}

/** 通过真实的文件输入框选中若干图片（走 `handleFileChange` 那条通道）。 */
async function attachImages(root: MemoryNode, names: string[]): Promise<void> {
  const input = harness.find(root, node => node.tag === 'input' && node.props.type === 'file');
  assert.ok(input, '找不到图片文件输入框（组件结构变了）');
  const files = names.map(name => new File([name], name, {type: 'image/png'}));
  (input!.props.onChange as (event: unknown) => void)({target: {files, value: ''}});
  await flush();
}

/** chip 上的缩略图按钮（预览入口）。 */
function previewButtons(root: MemoryNode): MemoryNode[] {
  return harness.findAll(root, node => node.tag === 'button' && node.props['data-testid'] === 'image-attachment-preview');
}

/** 预览对话框节点（从未打开过时不存在）。 */
function findDialog(root: MemoryNode): MemoryNode | undefined {
  return harness.find(root, node => node.tag === 'dialog');
}

/** 对话框当前是否处于 open 状态（`data-open` 与原生 dialog 同步）。 */
function isDialogOpen(root: MemoryNode): boolean {
  const dialog = findDialog(root);
  return dialog !== undefined && dialog.props['data-open'] === '';
}

/** 对话框里的大图节点。 */
function findDialogImage(root: MemoryNode): MemoryNode | undefined {
  const dialog = findDialog(root);
  return dialog ? harness.find(dialog, node => node.tag === 'img') : undefined;
}

/** 触发一次按钮点击（编译后的处理器带 `.stop` 修饰符，事件对象要能 stopPropagation）。 */
function clickButton(node: MemoryNode): void {
  const handler = node.props.onClick as (event: unknown) => void;
  assert.ok(typeof handler === 'function', '节点上没有点击处理器');
  handler({stopPropagation() {}, preventDefault() {}});
}

/** 取源码里某个 `const xxx = (...) => {...};` 的函数体（用于顺序契约断言）。 */
function extractArrowBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `源码里找不到 ${name}`);
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, `${name} 的结束锚点失效（函数被改写后请同步本用例）`);
  return source.slice(start, end);
}
test('点击 chip 缩略图：预览对话框以 open 状态出现，大图就是该附件的预览地址', async t => {
  revokedUrls.length = 0;
  const root = mountInputArea(t);
  await flush();
  await attachImages(root, ['alpha.png', 'beta.png']);

  assert.equal(findDialog(root), undefined, '未点击缩略图时不该渲染预览对话框');
  const buttons = previewButtons(root);
  assert.equal(buttons.length, 2, '两张图片各自要有独立的预览入口');
  assert.match(String(buttons[0]!.props['aria-label']), /alpha\.png/, '预览入口必须是带文件名的可读 aria-label');
  assert.match(String(buttons[1]!.props['aria-label']), /beta\.png/, '第二张图的预览入口要指向它自己');

  clickButton(buttons[0]!);
  await flush();
  assert.equal(isDialogOpen(root), true, '点击缩略图后对话框必须打开');
  assert.equal(findDialogImage(root)?.props.src, 'blob:alpha.png', '大图 src 必须等于该附件的对象 URL');
  assert.match(String(findDialog(root)!.props['aria-label']), /alpha\.png/, '对话框 aria-label 要说明是哪张图');

  // 多张图片互不串台：点第二张换的是第二张的地址。
  clickButton(previewButtons(root)[1]!);
  await flush();
  assert.equal(findDialogImage(root)?.props.src, 'blob:beta.png', '点第二张必须显示第二张的地址');
});

test('关闭按钮 / Esc / 点击遮罩都能关闭预览', async t => {
  revokedUrls.length = 0;
  const root = mountInputArea(t);
  await flush();
  await attachImages(root, ['alpha.png']);

  // 1. 关闭按钮
  clickButton(previewButtons(root)[0]!);
  await flush();
  assert.equal(isDialogOpen(root), true, '前置条件：预览已打开');
  const closeButton = harness.find(findDialog(root)!, node => node.tag === 'button');
  assert.ok(closeButton, '对话框必须有关闭按钮');
  clickButton(closeButton!);
  await flush();
  assert.equal(isDialogOpen(root), false, '点击关闭按钮必须关闭预览');
  assert.equal(findDialogImage(root), undefined, '关闭后大图节点要消失，不留残留层');

  // 2. Esc（原生 dialog 会派 cancel；这里触发同一条处理器）
  clickButton(previewButtons(root)[0]!);
  await flush();
  assert.equal(isDialogOpen(root), true, '前置条件：预览重新打开');
  const escaped: string[] = [];
  (findDialog(root)!.props.onKeydown as (event: unknown) => void)({
    key: 'Escape',
    preventDefault: () => { escaped.push('prevent'); },
    stopPropagation: () => { escaped.push('stop'); },
  });
  await flush();
  assert.equal(isDialogOpen(root), false, 'Esc 必须关闭预览');
  assert.deepEqual(escaped, ['prevent', 'stop'], 'Esc 要拦下默认行为并阻止冒泡，避免连带关掉外层浮层');

  // 3. 点击遮罩（dialog 自身，不是里面的图）
  clickButton(previewButtons(root)[0]!);
  await flush();
  const dialog = findDialog(root)!;
  (dialog.props.onClick as (event: unknown) => void)({target: dialog, currentTarget: dialog});
  await flush();
  assert.equal(isDialogOpen(root), false, '点击遮罩必须关闭预览');

  assert.deepEqual(revokedUrls, [], '仅开关预览不得 revoke 任何对象 URL');
});

test('预览中删除该附件：先关预览再释放对象 URL，不残留裂图', async t => {
  revokedUrls.length = 0;
  const root = mountInputArea(t);
  await flush();
  await attachImages(root, ['alpha.png', 'beta.png']);

  clickButton(previewButtons(root)[0]!);
  await flush();
  assert.equal(isDialogOpen(root), true, '前置条件：预览已打开');

  const container = harness.find(root, node => node.props['data-testid'] === 'image-attachments');
  assert.ok(container, '找不到附件 chip 容器');
  const chipButtons = harness.findAll(container!, node => node.tag === 'button');
  assert.equal(chipButtons.length, 4, '每个 chip 应有「预览」与「删除」两个按钮');
  // 每个 chip 内顺序固定：先缩略图（预览），后删除。
  clickButton(chipButtons[1]!);
  await flush();

  assert.equal(isDialogOpen(root), false, '删除正在预览的附件必须先关闭预览');
  assert.equal(findDialogImage(root), undefined, '关闭后不得残留大图节点（否则就是裂图）');
  assert.deepEqual(revokedUrls, ['blob:alpha.png'], '该附件的对象 URL 必须被释放');
  assert.equal(previewButtons(root).length, 1, '剩余附件仍保留自己的预览入口');
});

test('单一实现与顺序契约：两处消费方共用 ImageLightbox，删除路径先关预览再 revoke', () => {
  const inputSource = harness.readSource('../src/components/chat/ChatInputArea.vue');
  assert.match(inputSource, /import ImageLightbox from '\.\.\/common\/ImageLightbox\.vue';/,
    '输入区必须复用公共预览组件');
  assert.doesNotMatch(inputSource, /<dialog/, '输入区不得再手写第二套 dialog 预览逻辑');

  const messageSource = harness.readSource('../src/components/chat/MessageImage.vue');
  assert.match(messageSource, /import ImageLightbox from '\.\.\/common\/ImageLightbox\.vue';/,
    '消息气泡必须复用同一份预览组件，否则就是两份实现');
  assert.doesNotMatch(messageSource, /<dialog/, '消息气泡不得再保留自建 dialog');

  // 顺序契约：revoke 会把图源抽走，所以「关预览」必须发生在它前面。
  const removeBody = extractArrowBody(inputSource, 'removeImageAttachment');
  const removeCloseIndex = removeBody.indexOf('closeImagePreview()');
  const revokeIndex = removeBody.indexOf('removeImage(index)');
  assert.ok(removeCloseIndex >= 0, 'removeImageAttachment 必须先关闭预览');
  assert.ok(revokeIndex > removeCloseIndex, '先关预览、再 removeImage（revoke），顺序不可反');

  const clearBody = extractArrowBody(inputSource, 'clearImageAttachments');
  assert.ok(clearBody.indexOf('closeImagePreview()') >= 0, 'clearImageAttachments 必须先关闭预览');
  assert.ok(clearBody.indexOf('closeImagePreview()') < clearBody.indexOf('clearImages()'),
    '先关预览、再 clearImages（统一 revoke），顺序不可反');
});


