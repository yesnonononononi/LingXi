import { computed } from 'vue';
import { useI18n } from '../../../i18n';
const messages = {
  'zh-CN': {
    scope: '保护范围与限制', fileLimits: '读取、写入、删除统一允许或禁止。普通目录可跨项目访问；卷根及运行资源上层的单个文件保守只读。应用配置与运行资源固定保护；MCP 暂不在本轮隐私隔离范围内。', access: '访问（读 / 写 / 删除）', fileActive: '新建执行生效；运行中的任务保留原策略。', terminalActive: '命令规则保存后用于后续调用，批准后执行也会重新检查禁止规则。未命中时沿用通用设置的命令权限。', mcpScope: 'MCP 第一版沿用宿主连接，尚不受文件隐私拒绝约束。',
    page: '安全中心', files: '文件安全', terminal: '命令安全', net: '网络安全',
    preset: '预设', custom: '自定义', allow: '允许', ask: '询问', deny: '禁止', read: '读取', write: '写入', delete: '删除',
    add: '添加', remove: '移除规则', up: '上移', down: '下移', enabled: '启用规则', defaults: '恢复默认',
    save: '保存更改', saving: '保存中…', saved: '已保存', dirty: '有未保存的更改', loading: '正在读取规则…', retry: '重新加载',
    loadError: '无法读取安全规则，请重试', saveError: '保存失败，编辑内容已保留。请检查规则或重新加载最新版本。',
    resetError: '无法获取默认规则，请重试', contractError: '安全规则接口数据不完整',
    fileHint: '原生禁止路径及子目录访问，覆盖文件工具与终端。第一版不提供文件审批。',
    terminalHint: '禁止优先；其余按列表匹配。询问使用命令审批。命令文本规则不能拦截脚本内部的任意操作。',
    netHint: '普通出站访问默认允许，暂不启用域名或 HTTP 过滤。当前原生适配器仍限制宿主回环，MCP 宿主连接不受此限制。',
    netStatus: '默认允许出站访问', netDetail: '网络表保留默认允许策略；暂不提供域名或 HTTP 拦截开关。',
    filePlaceholder: '绝对路径，或 %USERPROFILE%/.ssh', terminalPlaceholder: '例如：git push',
    program: '程序名', prefix: '命令前缀', empty: '暂无规则，未命中路径默认允许',
    rules: '规则列表', moveHint: '支持预设与自定义规则；恢复默认后需保存。',
    added: '已添加到草稿，请保存使其生效', invalidPattern: '请填写规则匹配内容',
  },
  'en-US': {
    scope: 'Protection scope and limits', fileLimits: 'Read, write and delete share one action. Ordinary directories allow cross-project access. Flat files at volume roots and runtime ancestors remain read-only. Configuration and runtime files stay protected. Host MCP is outside this privacy boundary.', access: 'Access (read / write / delete)', fileActive: 'Applies to new execution sandboxes. Running tasks retain their policy.', terminalActive: 'Command rules apply to subsequent calls. Approved commands are checked again for new denials. Unmatched commands use the general command setting.', mcpScope: 'MCP uses host connections in v1 and is outside native file privacy protection.',
    page: 'Security', files: 'File security', terminal: 'Command security', net: 'Network security',
    preset: 'Preset', custom: 'Custom', allow: 'Allow', ask: 'Ask', deny: 'Deny', read: 'Read', write: 'Write', delete: 'Delete',
    add: 'Add', remove: 'Remove rule', up: 'Move up', down: 'Move down', enabled: 'Enable rule', defaults: 'Reset defaults',
    save: 'Save changes', saving: 'Saving…', saved: 'Saved', dirty: 'Unsaved changes', loading: 'Loading rules…', retry: 'Reload',
    loadError: 'Unable to load security rules. Please retry.', saveError: 'Save failed. Your edits are retained. Check the rules or reload the latest revision.',
    resetError: 'Unable to load defaults. Please retry.', contractError: 'Incomplete security-rule response',
    fileHint: 'Native denial protects paths and descendants from file tools and terminal processes. File access approval is unavailable in v1.',
    terminalHint: 'Deny takes precedence; other rules match in list order. Ask uses command approval. Text rules cannot intercept arbitrary operations inside scripts.',
    netHint: 'Outbound access is allowed without domain or HTTP filtering. The current native adapter still restricts host loopback. Host MCP connections are unaffected.',
    netStatus: 'Outbound access allowed by default', netDetail: 'The network table retains the default allow policy. Domain and HTTP filtering controls are unavailable.',
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
