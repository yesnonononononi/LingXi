import { computed } from 'vue';
import { useI18n } from '../../../i18n';

const messages = {
  'zh-CN': {
    page: '个性化', title: '灵犀对你的称呼', name: '灵犀的名字', empty: '暂无内容，点击编辑添加',
    style: '回复风格', styleHint: '选择灵犀回复的默认语气。', instruction: '自定义指令',
    instructionHint: '设置你偏好的工作规范与回答方式。', placeholder: '例如：回答先给结论再展开…',
    edit: '编辑', cancel: '取消', save: '保存更改', saving: '正在保存…', saved: '已保存',
    loading: '正在加载个性化设置…', retry: '重新加载', loadError: '无法读取个性化设置',
    contractError: '个性化配置或回复风格数据不完整，请检查后端接口',
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
    styles: { DEFAULT: 'Default', PROFESSIONAL_STRICT: 'Professional', FRIENDLY: 'Friendly', DIRECT: 'Direct',
      IMAGINATIVE: 'Imaginative', EFFECTIVE: 'Practical', TOXIC_TALK: 'Witty', INSPIRATIONAL_GUIDANCE: 'Guiding' } as Record<string, string>,
  },
};

export function usePersonalizationCopy() {
  const { locale } = useI18n();
  return computed(() => messages[locale.value]);
}
