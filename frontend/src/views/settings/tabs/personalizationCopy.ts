import {computed} from 'vue';
import {useI18n} from '../../../i18n';

const messages = {
  'zh-CN': {
    page: '个性化', title: '灵犀对你的称呼', name: '灵犀的名字', empty: '暂无内容，点击编辑添加',
    style: '回复风格', styleHint: '选择灵犀回复的默认语气。', instruction: '自定义指令',
    instructionHint: '设置你偏好的工作规范与回答方式。', placeholder: '例如：回答先给结论再展开…',
    edit: '编辑', cancel: '取消', save: '保存更改', saving: '正在保存…', saved: '已保存',
    loading: '正在加载个性化设置…', retry: '重新加载', loadError: '无法读取个性化设置',
    contractError: '个性化配置或回复风格数据不完整，请检查后端接口',
    shortcuts: '快捷键', shortcutsHint: '点击右侧按键后按下组合键即可录制（Esc 取消）。除发送键外都必须带 Ctrl 或 Alt。',
    shortcutRecording: '请按下组合键…', shortcutReset: '恢复默认', shortcutConflict: '快捷键冲突',
    shortcutResetAll: '全部恢复默认',
    shortcutProblems: {
      empty: '组合键不能为空', unparsable: '无法识别的组合键', 'needs-modifier': '请带上 Ctrl/⌘ 或 Alt，否则会抢走正常输入',
    } as Record<string, string>,
    shortcutLabels: {
      toggleSidebar: '收起/展开会话侧边栏', togglePreview: '显示/隐藏右侧预览框',
      toggleSettings: '打开/关闭设置页', newSession: '新建会话',
      sendMessage: '发送消息', insertNewline: '输入框换行',
    } as Record<string, string>,
    shortcutScopes: { global: '全局', input: '输入框' } as Record<string, string>,
    styles: { DEFAULT: '默认', PROFESSIONAL_STRICT: '专业严谨', FRIENDLY: '亲和友善', DIRECT: '直言不讳',
      IMAGINATIVE: '天马行空', EFFECTIVE: '高效务实', TOXIC_TALK: '毒舌吐槽', INSPIRATIONAL_GUIDANCE: '启发引导' } as Record<string, string>,
  },
  'en-US': {
    page: 'Personalization', title: 'What LingXi calls you', name: 'LingXi’s name', empty: 'Not set. Click to add',
    style: 'Response style', styleHint: 'Choose the default tone for LingXi’s replies.', instruction: 'Custom instructions',
    instructionHint: 'Set your preferred working rules and response style.', placeholder: 'For example: start with the conclusion…',
    edit: 'Edit', cancel: 'Cancel', save: 'Save changes', saving: 'Saving…', saved: 'Saved',
    loading: 'Loading personalization…', retry: 'Reload', loadError: 'Unable to load personalization',
    contractError: 'Personalization or response style data is incomplete. Check the backend API.',
    shortcuts: 'Keyboard shortcuts', shortcutsHint: 'Click a key field and press the combination (Esc cancels). Everything except the send key needs Ctrl or Alt.',
    shortcutRecording: 'Press a combination…', shortcutReset: 'Reset', shortcutConflict: 'Shortcut conflict',
    shortcutResetAll: 'Reset all',
    shortcutProblems: {
      empty: 'A combination is required', unparsable: 'Unrecognized combination', 'needs-modifier': 'Add Ctrl/⌘ or Alt, otherwise normal typing is hijacked',
    } as Record<string, string>,
    shortcutLabels: {
      toggleSidebar: 'Toggle session sidebar', togglePreview: 'Toggle preview panel',
      toggleSettings: 'Toggle settings', newSession: 'New chat',
      sendMessage: 'Send message', insertNewline: 'Insert line break',
    } as Record<string, string>,
    shortcutScopes: { global: 'Global', input: 'Input' } as Record<string, string>,
    styles: { DEFAULT: 'Default', PROFESSIONAL_STRICT: 'Professional', FRIENDLY: 'Friendly', DIRECT: 'Direct',
      IMAGINATIVE: 'Imaginative', EFFECTIVE: 'Practical', TOXIC_TALK: 'Witty', INSPIRATIONAL_GUIDANCE: 'Guiding' } as Record<string, string>,
  },
};

export function usePersonalizationCopy() {
  const { locale } = useI18n();
  return computed(() => messages[locale.value]);
}
