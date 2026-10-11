import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillAPI } from '../src/services/skill';
import { useSkillMenu } from '../src/composables/useSkillMenu';
import http from '../src/services/interceptor';
import { t } from '../src/i18n';
import type { Result } from '../src/services/types';
import type { SkillVO } from '../src/types/chat';

/** 后续技能项名称唯一，保证断言能定位到具体条目 */
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

test('open 加载清单并按关键字过滤 name 与 description', async (t) => {
  t.mock.method(http, 'get', async () => ok([
    { name: 'pdf', description: '处理 PDF 文件' },
    { name: 'xlsx', description: '表格技能 covers spreadsheet' },
  ]));
  const menu = useSkillMenu();
  menu.open();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(menu.skills.value.length, 2);
  assert.equal(menu.loadError.value, '');

  menu.searchQuery.value = 'PDF';
  assert.deepEqual(menu.filteredSkills.value.map(s => s.name), ['pdf']);
  menu.searchQuery.value = 'spreadsheet';
  assert.deepEqual(menu.filteredSkills.value.map(s => s.name), ['xlsx']);
  menu.searchQuery.value = '不存在';
  assert.equal(menu.filteredSkills.value.length, 0);
});

test('后端返回失败码时清空清单并暴露错误文案', async (t) => {
  t.mock.method(http, 'get', async () => ({ code: 0, errMsg: '服务不可用' }));
  const menu = useSkillMenu();
  menu.open();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(menu.skills.value, []);
  assert.equal(menu.loadError.value, '服务不可用');
  assert.equal(menu.isLoading.value, false);
});

test('请求异常时同样落错误态而不是抛出', async (t) => {
  t.mock.method(http, 'get', async () => { throw new Error('network down'); });
  const menu = useSkillMenu();
  menu.open();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(menu.loadError.value, 'network down');
});

test('旧请求的慢响应不得覆盖新一次加载（序号守卫）', async (t) => {
  let releaseFirst!: (value: Result<SkillVO[]>) => void;
  const gate = new Promise<Result<SkillVO[]>>(resolve => { releaseFirst = resolve; });
  const get = t.mock.method(http, 'get', async () => gate);
  const menu = useSkillMenu();
  menu.open();
  await new Promise(resolve => setTimeout(resolve, 0));

  get.mock.mockImplementation(async () => ok([{ name: 'fresh', description: '新清单' }]));
  menu.open();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(menu.skills.value.map(s => s.name), ['fresh'], '新请求应已生效');
  menu.searchQuery.value = 'f';

  // 旧请求此刻才回来，绝不能把 fresh 覆盖掉，也不能动用户的过滤词与加载态
  releaseFirst(ok([{ name: 'stale', description: '过期清单' }]));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(menu.skills.value.map(s => s.name), ['fresh']);
  assert.equal(menu.searchQuery.value, 'f');
  assert.equal(menu.isLoading.value, false);
});

test('close 关闭浮层且不触发新请求', async (t) => {
  const get = t.mock.method(http, 'get', async () => ok([{ name: 'pdf', description: '' }]));
  const menu = useSkillMenu();
  menu.open();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(get.mock.callCount(), 1);
  menu.searchQuery.value = 'pdf';
  menu.close();
  assert.equal(menu.isOpen.value, false);
  assert.equal(get.mock.callCount(), 1);
  menu.close();
  assert.equal(menu.isOpen.value, false, '重复 close 不应报错也不应重开');
});

test('i18n 提供中英文 /skill 文案且不是裸键名', () => {
  for (const key of ['chat.command.skill', 'chat.input.searchSkill', 'chat.input.skillEmpty']) {
    assert.notEqual(t(key), key, `缺少文案: ${key}`);
  }
});
