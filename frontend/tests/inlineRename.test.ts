import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nextTick} from 'vue';
import {useInlineRename} from '../src/composables/useInlineRename';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Recorded {
  value: string;
  target: string;
}

/** 造一个可控宿主：读值/读目标/写入全部记录，便于断言「提交给了谁、写了几次」。 */
function setup(options: {value?: string; target?: string | null; canEdit?: boolean} = {}) {
  const state = {
    value: options.value ?? '旧标题',
    target: 'A' in options ? options.target : 'S1',
    canEdit: options.canEdit ?? true,
  };
  const writes: Recorded[] = [];
  const rename = useInlineRename<string>({
    canEdit: () => state.canEdit,
    readValue: () => state.value,
    readTarget: () => state.target ?? null,
    commit: (value: string, target: string) => {
      writes.push({value, target});
    },
  });
  return {state, writes, rename};
}

test('双击进入编辑：草稿取当前标题，Enter 提交并写回原目标', async () => {
  const {state, writes, rename} = setup();

  rename.start();
  await nextTick();
  assert.equal(rename.editing.value, true);
  assert.equal(rename.draft.value, '旧标题');

  rename.draft.value = '  新标题  ';
  rename.handleKeydown({key: 'Enter', isComposing: false, preventDefault() {}} as KeyboardEvent);

  assert.equal(rename.editing.value, false);
  assert.deepEqual(writes, [{value: '新标题', target: 'S1'}]);
  assert.equal(state.value, '旧标题', '写入动作归宿主，composable 不自己改数据');
});

test('提交目标是进入编辑那一刻的快照：编辑途中换会话不会写错人', () => {
  const {state, writes, rename} = setup({target: 'S1'});

  rename.start();
  state.target = 'S2';
  state.value = '别的会话';
  rename.draft.value = '改个名';
  rename.commitEdit();

  assert.deepEqual(writes, [{value: '改个名', target: 'S1'}]);
});

test('Esc 取消：不写库、退出编辑态', async () => {
  const {writes, rename} = setup();

  rename.start();
  await nextTick();
  rename.draft.value = '不该生效';
  rename.handleKeydown({key: 'Escape', isComposing: false, preventDefault() {}} as KeyboardEvent);

  assert.equal(rename.editing.value, false);
  assert.deepEqual(writes, []);
});

test('失焦提交只认一次：Enter 之后元素卸载再触发 blur 不会重复打接口', async () => {
  const {writes, rename} = setup();

  rename.start();
  await nextTick();
  rename.draft.value = '新标题';
  rename.commitEdit();
  rename.commitEdit();

  assert.equal(writes.length, 1);
});

test('空标题与未改动都不提交', () => {
  const blank = setup({value: '旧标题'});
  blank.rename.start();
  blank.rename.draft.value = '   ';
  blank.rename.commitEdit();
  assert.deepEqual(blank.writes, [], '空标题不写库');

  const untouched = setup({value: '旧标题'});
  untouched.rename.start();
  untouched.rename.commitEdit();
  assert.deepEqual(untouched.writes, [], '没改动不写库');
});

test('不允许编辑时（临时会话）双击无效', () => {
  const {writes, rename} = setup({canEdit: false});

  rename.start();
  assert.equal(rename.editing.value, false);
  rename.draft.value = '偷偷改名';
  rename.commitEdit();
  assert.deepEqual(writes, []);
});

test('输入法组合态的 Enter 不算提交（中文候选框回车）', async () => {
  const {writes, rename} = setup();

  rename.start();
  await nextTick();
  rename.draft.value = '中文标题';
  rename.handleKeydown({key: 'Enter', isComposing: true, preventDefault() {}} as KeyboardEvent);

  assert.equal(rename.editing.value, true, '组合输入期间仍留在编辑态');
  assert.deepEqual(writes, []);
});

test('顶部横条接线契约：双击标题进入编辑，提交仍走唯一重命名入口', () => {
  const chatViewSrc = fs.readFileSync(path.resolve(__dirname, '../src/views/chat/ChatView.vue'), 'utf8');

  assert.match(chatViewSrc, /@dblclick="startHeaderTitleRename"/, '标题必须挂双击进入编辑');
  assert.match(chatViewSrc, /data-test="chat-title-input"/, '编辑态必须有输入框测试钩子');
  assert.match(chatViewSrc, /@blur="commitHeaderTitleRename"/, '失焦必须提交');
  assert.match(chatViewSrc, /@keydown="handleHeaderTitleKeydown"/, 'Enter/Esc 必须走同一个键盘处理器');
  assert.match(
    chatViewSrc,
    /commit: \(name: string, sessionId: string\): void => \{\s*void handleRenameSession\(sessionId, name\);/,
    '就地改名必须复用 handleRenameSession，不得另开写入路径'
  );
  assert.match(
    chatViewSrc,
    /canEdit: \(\) => canRenameHeaderTitle\.value/,
    '临时会话不能就地改名，必须有过闸门'
  );
});
