/**
 * 访问档位展示真源守卫（2026-11 三档诚实性审计）。
 *
 * <p><b>被钉住的事实</b>：档位语义依赖执行环境。本地执行环境不走沙箱构建，终端没有任何目录围栏，
 * 所以「只读模式 = 不修改文件」在本地只剩「文件编辑工具被禁用」；沙箱下「普通修改」在 Windows 也是
 * 整盘普通目录可写。安全中心的「实际效果」文案键因此按 {@code 档位 + 环境} 组合生成。</p>
 *
 * <p>输入区上拉框是例外：档位说明只讲档位本身（`accessMenuDesc*`），环境差异收敛到标题旁的
 * 常驻感叹号悬停提示（按环境分身：沙箱只拦终端、不拦文件读写），免得每档都拖一条长尾巴。</p>
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
  isFullAccessMode,
  isTerminalOutsideAccessControl,
  resolveAccessBadgeKey,
  resolveAccessImpactKey,
  resolveAccessMenuDescKey,
  resolveAccessPreset,
  resolveAccessTipKey,
  resolveSandboxState,
  resolveTerminalCaveatKey,
} from '../src/utils/accessModePresentation';

const messagesSource = readFileSync(resolve(process.cwd(), 'src/i18n/messages.ts'), 'utf8');
const menuSource = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatInputAccessMenu.vue'), 'utf8');
const securityCopySource = readFileSync(resolve(process.cwd(), 'src/views/settings/tabs/securityCopy.ts'), 'utf8');
const settingsSource = readFileSync(resolve(process.cwd(), 'src/views/settings/tabs/useSandboxSettings.ts'), 'utf8');
const tabSource = readFileSync(resolve(process.cwd(), 'src/views/settings/tabs/SecurityTab.vue'), 'utf8');
const inputSource = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatInputArea.vue'), 'utf8');
const viewSource = readFileSync(resolve(process.cwd(), 'src/views/chat/ChatView.vue'), 'utf8');
const workspaceSource = readFileSync(resolve(process.cwd(), 'src/views/chat/useChatWorkspace.ts'), 'utf8');
const viewModelSource = readFileSync(resolve(process.cwd(), 'src/views/chat/useChatView.ts'), 'utf8');

test('执行环境三态：NONE 不得被折叠成已关闭', () => {
  assert.equal(resolveSandboxState('SAND_BOX'), 'ON');
  assert.equal(resolveSandboxState('LOCAL'), 'OFF');
  assert.equal(resolveSandboxState('NONE'), 'UNSET');
  assert.equal(resolveSandboxState(undefined), 'UNSET');
});

test('档位短名：未知值不得被当成完全访问', () => {
  assert.equal(resolveAccessPreset('APPROVAL_REQUIRED'), 'ApprovalRequired');
  assert.equal(resolveAccessPreset('DELEGATED_APPROVAL'), 'DelegatedApproval');
  assert.equal(resolveAccessPreset('FULL_ACCESS'), 'Full');
  assert.equal(resolveAccessPreset(undefined), 'ApprovalRequired');
  assert.equal(resolveAccessPreset('垃圾值'), 'ApprovalRequired');
});

test('可选三档均允许工作区内写入，不存在只读误导组合', () => {
  assert.equal(isAccessModeMismatch('APPROVAL_REQUIRED', 'OFF'), false);
  assert.equal(isAccessModeMismatch('APPROVAL_REQUIRED', 'UNSET'), false);
  assert.equal(isAccessModeMismatch('DELEGATED_APPROVAL', 'ON'), false);
  assert.equal(isAccessModeMismatch('FULL_ACCESS', 'OFF'), false);
});

test('文案键按「档位 + 环境」组合，不得出现无环境后缀的单一键', () => {
  assert.equal(resolveAccessImpactKey('APPROVAL_REQUIRED', 'ON'), 'settings.general.impactApprovalRequiredSandbox');
  assert.equal(resolveAccessImpactKey('APPROVAL_REQUIRED', 'OFF'), 'settings.general.impactApprovalRequiredLocal');
  assert.equal(resolveAccessImpactKey('DELEGATED_APPROVAL', 'ON'), 'settings.general.impactDelegatedApprovalSandbox');
  assert.equal(resolveAccessImpactKey('FULL_ACCESS', 'UNSET'), 'settings.general.impactFullLocal');
  assert.equal(resolveAccessTipKey('APPROVAL_REQUIRED', 'ON'), 'chat.input.accessModeTipApprovalRequiredSandbox');
  assert.equal(resolveAccessTipKey('APPROVAL_REQUIRED', 'OFF'), 'chat.input.accessModeTipApprovalRequiredLocal');
  assert.equal(resolveAccessBadgeKey('FULL_ACCESS'), 'chat.input.accessModeBadgeFull');
  assert.equal(resolveAccessMenuDescKey('APPROVAL_REQUIRED'), 'chat.input.accessMenuDescApprovalRequired');
  assert.equal(resolveAccessMenuDescKey('DELEGATED_APPROVAL'), 'chat.input.accessMenuDescDelegatedApproval');
  assert.equal(resolveAccessMenuDescKey('FULL_ACCESS'), 'chat.input.accessMenuDescFull');
  assert.equal(resolveAccessMenuDescKey(undefined), 'chat.input.accessMenuDescApprovalRequired');
});

test('组合出来的键在两个语种里都必须真实存在', () => {
  const keys = new Set<string>();
  for (const mode of ['APPROVAL_REQUIRED', 'DELEGATED_APPROVAL', 'FULL_ACCESS']) {
    for (const state of ['ON', 'OFF', 'UNSET'] as const) {
      keys.add(resolveAccessImpactKey(mode, state).split('.').pop() as string);
      keys.add(resolveAccessTipKey(mode, state).split('.').pop() as string);
    }
    keys.add(resolveAccessBadgeKey(mode).split('.').pop() as string);
    keys.add(resolveAccessMenuDescKey(mode).split('.').pop() as string);
  }
  // 金丝雀：先证明扫描器能命中，否则下面的「都在」可能假绿
  assert.match(messagesSource, /accessModeBadgeApprovalRequired:/, '金丝雀：messages.ts 未读到档位文案');
  for (const key of keys) {
    const hits = messagesSource.match(new RegExp(`\\b${key}:`, 'g')) ?? [];
    assert.equal(hits.length, 2, `文案键 ${key} 应在 zh-CN 与 en-US 里各出现一次，实际 ${hits.length} 次`);
  }
});

test('「文件规则只约束文件工具」必须写在安全中心提示里', () => {
  // 规则消费者已从沙箱策略改为工具层 FileSecurityPolicy，两个执行环境都生效；
  // 终端命令不吃这张表，提示里必须写明，别再回到「只在沙箱生效」的说法。
  assert.match(securityCopySource, /只约束文件工具，终端命令不受其约束/);
  assert.match(securityCopySource, /file tools only; terminal commands are not governed/);
  // 上面两条正匹配同时是金丝雀：能命中说明读到的确实是安全中心文案，下面的「不存在」才不会假绿。
  assert.doesNotMatch(securityCopySource, /只在沙箱执行环境生效/);
  assert.doesNotMatch(securityCopySource, /apply only in the sandbox environment/);
});

test('档位说明不再按环境分身，环境差异收敛到标题旁的常驻悬停提示', () => {
  // 金丝雀：先证明读到了组件源码，否则下面的「不走组合键」可能是假绿
  assert.match(menuSource, /data-testid="chat-access-terminal-caveat"/, '菜单缺少终端提示图标');
  assert.match(menuSource, /resolveAccessMenuDescKey\(/, '档位说明必须走静态文案真源');
  assert.doesNotMatch(menuSource, /resolveAccessImpactKey\(/, '上拉框说明不该再按环境切换，那是安全中心的职责');
  // 图标常驻（不受环境影响），非沙箱时转警示色
  assert.doesNotMatch(menuSource, /v-if="terminalCaveatVisible"/, '感叹号必须常驻，不能按环境隐藏');
  assert.match(menuSource, /terminalCaveatVisible \? 'text-amber-500' : MUTED/, '非沙箱环境必须给感叹号警示色');
});

test('「终端在非沙箱环境不受档位约束」必须由真源判定', () => {
  assert.equal(isTerminalOutsideAccessControl('LOCAL'), true);
  assert.equal(isTerminalOutsideAccessControl('UNSET'), true);
  assert.equal(isTerminalOutsideAccessControl('ON'), false);
  assert.match(menuSource, /isTerminalOutsideAccessControl\(/, '菜单必须走真源判据');
});

test('悬停说明按环境分开讲「沙箱拦谁」，不得再用一句糊住两种环境', () => {
  assert.equal(resolveTerminalCaveatKey('ON'), 'chat.input.accessMenuTerminalCaveatSandbox');
  assert.equal(resolveTerminalCaveatKey('OFF'), 'chat.input.accessMenuTerminalCaveatLocal');
  assert.equal(resolveTerminalCaveatKey('UNSET'), 'chat.input.accessMenuTerminalCaveatLocal');
  // 金丝雀：先证明读到了组件源码，否则下面的「走真源」可能是假绿
  assert.match(menuSource, /data-testid="chat-access-terminal-caveat"/, '菜单缺少终端提示图标');
  assert.match(menuSource, /resolveTerminalCaveatKey\(/, '悬停说明必须走按环境分身的真源');
  assert.doesNotMatch(menuSource, /accessMenuTerminalCaveat/, '组件不得直连悬停文案键（等于把环境判断写死）');
  for (const key of ['accessMenuTerminalCaveatSandbox', 'accessMenuTerminalCaveatLocal']) {
    const hits = messagesSource.match(new RegExp(`\\b${key}:`, 'g')) ?? [];
    assert.equal(hits.length, 2, `文案键 ${key} 应在 zh-CN 与 en-US 里各出现一次，实际 ${hits.length} 次`);
  }
});

test('「完全访问」行右侧必须常驻终端限制说明', () => {
  // 完全访问只放开文件工具，终端命令仍在沙箱与终端规则里：没有这枚提示，档位说明就是在撒谎
  assert.equal(isFullAccessMode('FULL_ACCESS'), true);
  assert.equal(isFullAccessMode('APPROVAL_REQUIRED'), false);
  assert.equal(isFullAccessMode('DELEGATED_APPROVAL'), false);
  assert.equal(isFullAccessMode(undefined), false);
  assert.match(menuSource, /data-testid="chat-access-full-terminal-caveat"/, '完全访问行缺少终端限制提示');
  assert.match(menuSource, /isFullAccessMode\(/, '完全访问判定必须走真源，不得内联比较档位字面量');
  const hits = messagesSource.match(/\baccessMenuFullTerminalCaveat:/g) ?? [];
  assert.equal(hits.length, 2, `accessMenuFullTerminalCaveat 应在两个语种里各出现一次，实际 ${hits.length} 次`);
});

test('安全中心与输入区消费同一份真源，不得各自硬编码档位判断', () => {
  assert.match(settingsSource, /resolveAccessImpactKey\(/, '安全中心未使用组合文案键');
  assert.match(settingsSource, /isAccessModeMismatch\(/, '安全中心未使用警示判据');
  assert.match(inputSource, /resolveAccessBadgeKey\(/, '输入区徽标未使用组合标签键');
  assert.doesNotMatch(settingsSource, /=== 'READ_ONLY_REVIEW'/, '档位判断应集中在 accessModePresentation');
  assert.doesNotMatch(inputSource, /=== 'READ_ONLY_REVIEW'/, '档位判断应集中在 accessModePresentation');
  assert.match(tabSource, /data-testid="security-access-impact"/, '缺少「实际效果」说明');
  assert.match(inputSource, /data-testid="chat-access-mode"/, '缺少输入区档位徽标');
});

/**
 * 档位切换必须端到端接通：声明事件 → 真的发出 → ChatView 绑定 → 落到 userConfig。
 *
 * <p>历史缺陷是「发出去却无人监听」的死事件（`updateMode` 的翻版），因此这条用例改成
 * 链路正对照：任何一环断掉都必须变红，同时禁止回到「只改本地状态」的假切换。</p>
 */
test('输入区档位切换必须端到端接通，不得再出现死事件', () => {
  assert.match(inputSource, /\(e: 'updateAccessMode'/, '输入区必须声明档位事件');
  assert.match(inputSource, /emit\('updateAccessMode'/, '输入区必须真的发出档位事件');
  assert.match(inputSource, /@select="handleSelectAccessMode"/, '权限上拉框的选中必须接到处理器上');
  assert.match(viewSource, /@updateAccessMode="handleUpdateAccessMode"/, 'ChatView 必须绑定档位处理函数');
  assert.match(viewSource, /handleUpdateAccessMode,/, 'ChatView 必须从 useChatView 取到该处理函数');
  assert.match(viewModelSource, /userConfig\.patch\('permissionMode'/, '切档必须写 userConfig，不得只改本地状态');
  assert.doesNotMatch(workspaceSource, /handleUpdateAccessMode/, '档位切换不属于工作空间模块');
});
