import test from 'node:test';
import assert from 'node:assert/strict';
import {SkillAPI} from '../src/services/skill';
import {useSkillList} from '../src/composables/useSkillList';
import http from '../src/services/interceptor';
import {t} from '../src/i18n';
import type {Result} from '../src/services/types';
import type {SkillVO} from '../src/types/chat';

/**
 * 技能清单只保留「加载」这一件事。
 *
 * <p>历史实现是个带 isOpen / searchQuery 的浮层状态机，于是输入区里长出了第二个技能框 ——
 * 点「+ → 技能」时新旧两个同时展开。现在清单由 `useSkillList` 提供、由「+」菜单渲染，
 * 这里的用例盯住加载语义（成功 / 失败码 / 异常 / 序号守卫），浮层形态不再有第二个实现。</p>
 */

function ok(skills: SkillVO[]): Result<SkillVO[]> {
  return { code: 1, data: skills };
}

test('SkillAPI.list 请求 GET /skill/list 并透传后端数据', async (t) => {
  const payload = ok([{ name: 'pdf', description: '处理 PDF 文件' }]);
  const get = t.mock.method(http, 'get', async () => payload);
  const res = await SkillAPI.list();
  assert.equal(get.mock.calls[0]!.arguments[0], '/skill/list');
  assert.equal(res.data![0]!.name, 'pdf');
});

test('load 拉取清单：成功后清掉错误态与加载态', async (t) => {
  t.mock.method(http, 'get', async () => ok([
    { name: 'pdf', description: '处理 PDF 文件' },
    { name: 'xlsx', description: '表格技能' },
  ]));
  const list = useSkillList();
  await list.load();
  assert.deepEqual(list.skills.value.map(s => s.name), ['pdf', 'xlsx']);
  assert.equal(list.loadError.value, '');
  assert.equal(list.isLoading.value, false);
});

test('后端返回失败码时清空清单并暴露错误文案', async (t) => {
  t.mock.method(http, 'get', async () => ({ code: 0, errMsg: '服务不可用' }));
  const list = useSkillList();
  await list.load();
  assert.deepEqual(list.skills.value, []);
  assert.equal(list.loadError.value, '服务不可用');
  assert.equal(list.isLoading.value, false);
});

test('请求异常时同样落错误态而不是抛出', async (t) => {
  t.mock.method(http, 'get', async () => { throw new Error('network down'); });
  const list = useSkillList();
  await list.load();
  assert.equal(list.loadError.value, 'network down');
});

test('旧请求的慢响应不得覆盖新一次加载（序号守卫）', async (t) => {
  let releaseFirst!: (value: Result<SkillVO[]>) => void;
  const gate = new Promise<Result<SkillVO[]>>(resolve => { releaseFirst = resolve; });
  const get = t.mock.method(http, 'get', async () => gate);
  const list = useSkillList();
  void list.load();
  await new Promise(resolve => setTimeout(resolve, 0));

  get.mock.mockImplementation(async () => ok([{ name: 'fresh', description: '新清单' }]));
  await list.load();
  assert.deepEqual(list.skills.value.map(s => s.name), ['fresh'], '新请求应已生效');

  // 旧请求此刻才回来，绝不能把 fresh 覆盖掉
  releaseFirst(ok([{ name: 'stale', description: '过期清单' }]));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(list.skills.value.map(s => s.name), ['fresh']);
  assert.equal(list.isLoading.value, false);
});

test('i18n 提供中英文 /skill 文案且不是裸键名', () => {
  for (const key of ['chat.command.skill', 'chat.input.searchSkill', 'chat.input.skillEmpty']) {
    assert.notEqual(t(key), key, `缺少文案: ${key}`);
  }
});
