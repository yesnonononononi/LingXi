import { computed } from 'vue';
import { useI18n } from '../../../i18n';
const messages = {
  'zh-CN': {
    pending: '当前仅保存规则配置，执行层尚未切换；文件、命令与网络策略暂未按本页配置生效。',
    page: '安全中心', files: '文件安全', terminal: '命令安全', net: '网络安全',
    preset: '预设', custom: '自定义', allow: '允许', ask: '询问', deny: '禁止', read: '读取', write: '写入', delete: '删除',
    add: '添加', remove: '移除规则', up: '上移', down: '下移', enabled: '启用规则', defaults: '恢复默认',
    save: '保存更改', saving: '保存中…', saved: '已保存', dirty: '有未保存的更改', loading: '正在读取规则…', retry: '重新加载',
    loadError: '无法读取安全规则，请重试', saveError: '保存失败，编辑内容已保留。请检查规则或重新加载最新版本。',
    resetError: '无法获取默认规则，请重试', contractError: '安全规则接口数据不完整',
    fileHint: '保护路径及其子目录；禁止优先于允许，未命中路径默认允许。第一版暂不提供文件访问询问。',
    terminalHint: '禁止优先；其余按列表匹配。询问使用命令审批。命令文本规则不能拦截脚本内部的任意操作。',
    netHint: '第一版不限制网络访问，外网、局域网、回环和 MCP 均允许。网络过滤尚未启用。',
    netStatus: '默认允许访问网络', netDetail: '网络表保留默认允许策略；暂不提供域名或 HTTP 拦截开关。',
    filePlaceholder: '绝对路径，或 %USERPROFILE%/.ssh', terminalPlaceholder: '例如：git push',
    program: '程序名', prefix: '命令前缀', empty: '暂无规则，未命中路径默认允许',
    rules: '规则列表', moveHint: '支持预设与自定义规则；恢复默认后需保存。',
    added: '已添加到草稿，请保存使其生效', invalidPattern: '请填写规则匹配内容',
  },
  'en-US': {
    pending: 'Configuration only. The execution layer has not switched; these file, command and network settings are not active yet.',
    page: 'Security', files: 'File security', terminal: 'Command security', net: 'Network security',
    preset: 'Preset', custom: 'Custom', allow: 'Allow', ask: 'Ask', deny: 'Deny', read: 'Read', write: 'Write', delete: 'Delete',
    add: 'Add', remove: 'Remove rule', up: 'Move up', down: 'Move down', enabled: 'Enable rule', defaults: 'Reset defaults',
    save: 'Save changes', saving: 'Saving…', saved: 'Saved', dirty: 'Unsaved changes', loading: 'Loading rules…', retry: 'Reload',
    loadError: 'Unable to load security rules. Please retry.', saveError: 'Save failed. Your edits are retained. Check the rules or reload the latest revision.',
    resetError: 'Unable to load defaults. Please retry.', contractError: 'Incomplete security-rule response',
    fileHint: 'Protects a path and its descendants. Deny takes precedence. Unmatched paths are allowed. File access approval is unavailable in v1.',
    terminalHint: 'Deny takes precedence; other rules match in list order. Ask uses command approval. Text rules cannot intercept arbitrary operations inside scripts.',
    netHint: 'Network access is unrestricted in v1, including internet, LAN, loopback and MCP. Filtering is not enabled.',
    netStatus: 'Network access allowed by default', netDetail: 'The network table retains the default allow policy. Domain and HTTP filtering controls are unavailable.',
    filePlaceholder: 'Absolute path or %USERPROFILE%/.ssh', terminalPlaceholder: 'For example: git push',
    program: 'Program name', prefix: 'Command prefix', empty: 'No rules. Unmatched paths are allowed.',
    rules: 'Rules', moveHint: 'Presets and custom rules. Save after resetting defaults.',
    added: 'Added to draft. Save to apply.', invalidPattern: 'Enter a rule pattern.',
  },
};
export function useSecurityCopy() {
  const { locale } = useI18n();
  return computed(() => messages[locale.value]);
}
