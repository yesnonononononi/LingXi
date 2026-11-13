/**
 * 访问档位展示真源守卫（2026-11 三档诚实性审计）。
 *
 * <p><b>被钉住的事实</b>：档位语义依赖执行环境。本地执行环境不走沙箱构建，终端没有任何目录围栏，
 * 所以「只读模式 = 不修改文件」在本地只剩「文件编辑工具被禁用」；沙箱下「普通修改」在 Windows 也是
 * 整盘普通目录可写。文案键因此按 {@code 档位 + 环境} 组合生成。</p>
 *
 * <p>组合式文案键绕过了 TS 的字面量检查，所以这里同时断言 messages.ts 里**两个语种**都真有这些键，
 * 否则界面会渲染出裸键名而不是文案。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isAccessModeMismatch,
  resolveAccessBadgeKey,
  resolveAccessImpactKey,
  resolveAccessPreset,
  resolveAccessTipKey,
  resolveSandboxState,
} from '../src/utils/accessModePresentation';

const messagesSource = readFileSync(resolve(process.cwd(), 'src/i18n/messages.ts'), 'utf8');
const securityCopySource = readFileSync(resolve(process.cwd(), 'src/views/settings/tabs/securityCopy.ts'), 'utf8');
const settingsSource = readFileSync(resolve(process.cwd(), 'src/views/settings/tabs/useSandboxSettings.ts'), 'utf8');
const tabSource = readFileSync(resolve(process.cwd(), 'src/views/settings/tabs/SecurityTab.vue'), 'utf8');
const inputSource = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatInputArea.vue'), 'utf8');
const viewSource = readFileSync(resolve(process.cwd(), 'src/views/chat/ChatView.vue'), 'utf8');
const workspaceSource = readFileSync(resolve(process.cwd(), 'src/views/chat/useChatWorkspace.ts'), 'utf8');

test('执行环境三态：NONE 不得被折叠成已关闭', () => {
  assert.equal(resolveSandboxState('SAND_BOX'), 'ON');
  assert.equal(resolveSandboxState('LOCAL'), 'OFF');
  assert.equal(resolveSandboxState('NONE'), 'UNSET');
  assert.equal(resolveSandboxState(undefined), 'UNSET');
});

test('档位短名：未知值不得被当成完全访问', () => {
  assert.equal(resolveAccessPreset('READ_ONLY_IN_WORKSPACE'), 'ReadOnly');
  assert.equal(resolveAccessPreset('OUT_OF_WORKSPACE'), 'Full');
  assert.equal(resolveAccessPreset('IN_WORKSPACE'), 'InWorkspace');
  assert.equal(resolveAccessPreset(undefined), 'InWorkspace');
  assert.equal(resolveAccessPreset('垃圾值'), 'InWorkspace');
});

test('本地/未设置 + 只读必须给出警示，沙箱下的只读才是真只读', () => {
  assert.equal(isAccessModeMismatch('READ_ONLY_IN_WORKSPACE', 'OFF'), true);
  assert.equal(isAccessModeMismatch('READ_ONLY_IN_WORKSPACE', 'UNSET'), true);
  assert.equal(isAccessModeMismatch('READ_ONLY_IN_WORKSPACE', 'ON'), false);
  assert.equal(isAccessModeMismatch('IN_WORKSPACE', 'OFF'), false);
  assert.equal(isAccessModeMismatch('OUT_OF_WORKSPACE', 'OFF'), false);
});

test('文案键按「档位 + 环境」组合，不得出现无环境后缀的单一键', () => {
  assert.equal(resolveAccessImpactKey('READ_ONLY_IN_WORKSPACE', 'ON'), 'settings.general.impactReadOnlySandbox');
  assert.equal(resolveAccessImpactKey('READ_ONLY_IN_WORKSPACE', 'OFF'), 'settings.general.impactReadOnlyLocal');
  assert.equal(resolveAccessImpactKey('OUT_OF_WORKSPACE', 'UNSET'), 'settings.general.impactFullLocal');
  assert.equal(resolveAccessTipKey('IN_WORKSPACE', 'ON'), 'chat.input.accessModeTipInWorkspaceSandbox');
  assert.equal(resolveAccessTipKey('IN_WORKSPACE', 'OFF'), 'chat.input.accessModeTipInWorkspaceLocal');
  assert.equal(resolveAccessBadgeKey('OUT_OF_WORKSPACE'), 'chat.input.accessModeBadgeFull');
});

test('组合出来的键在两个语种里都必须真实存在', () => {
  const keys = new Set<string>();
  for (const mode of ['READ_ONLY_IN_WORKSPACE', 'IN_WORKSPACE', 'OUT_OF_WORKSPACE']) {
    for (const state of ['ON', 'OFF', 'UNSET'] as const) {
      keys.add(resolveAccessImpactKey(mode, state).split('.').pop() as string);
      keys.add(resolveAccessTipKey(mode, state).split('.').pop() as string);
    }
    keys.add(resolveAccessBadgeKey(mode).split('.').pop() as string);
  }
  // 金丝雀：先证明扫描器能命中，否则下面的「都在」可能假绿
  assert.match(messagesSource, /accessModeBadgeReadOnly:/, '金丝雀：messages.ts 未读到档位文案');
  for (const key of keys) {
    const hits = messagesSource.match(new RegExp(`\\b${key}:`, 'g')) ?? [];
    assert.equal(hits.length, 2, `文案键 ${key} 应在 zh-CN 与 en-US 里各出现一次，实际 ${hits.length} 次`);
  }
});

test('「文件规则只在沙箱生效」必须写在安全中心提示里', () => {
  assert.match(securityCopySource, /文件规则只在沙箱执行环境生效/);
  assert.match(securityCopySource, /file rules apply only in the sandbox environment/);
});

test('安全中心与输入区消费同一份真源，不得各自硬编码档位判断', () => {
  assert.match(settingsSource, /resolveAccessImpactKey\(/, '安全中心未使用组合文案键');
  assert.match(settingsSource, /isAccessModeMismatch\(/, '安全中心未使用警示判据');
  assert.match(inputSource, /resolveAccessBadgeKey\(/, '输入区徽标未使用组合标签键');
  assert.doesNotMatch(settingsSource, /=== 'READ_ONLY_IN_WORKSPACE'/, '档位判断应集中在 accessModePresentation');
  assert.doesNotMatch(inputSource, /=== 'READ_ONLY_IN_WORKSPACE'/, '档位判断应集中在 accessModePresentation');
  assert.match(tabSource, /data-testid="security-access-impact"/, '缺少「实际效果」说明');
  assert.match(inputSource, /data-testid="chat-access-mode"/, '缺少输入区档位徽标');
});

test('聊天页档位事件死代码不得回流', () => {
  assert.doesNotMatch(inputSource, /updateAccessMode/, '发出去却无人监听的事件不允许回来');
  assert.doesNotMatch(viewSource, /handleUpdateAccessMode/, 'ChatView 不应再绑定不存在的处理函数');
  assert.doesNotMatch(workspaceSource, /handleUpdateAccessMode/, '未使用的事件处理函数应删除');
});
