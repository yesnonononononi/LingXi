import { computed } from 'vue';
import { useI18n } from '../../../i18n';

const messages = {
  'zh-CN': {
    batch: '批量添加模型', next: '保存并添加模型', connection: '连接配置', selection: '选择模型',
    urlHelp: '填写 API 根地址，包含服务要求的 /v1 等路径。新模型会复制此地址。',
    keyHelp: '批量添加时自动复制此密钥；编辑留空保留已有密钥。',
    intro: '从提供商获取模型，或直接输入模型名称。', remote: '获取并选择', manual: '手动输入',
    fetch: '获取模型列表', fetching: '正在获取…', retry: '重新获取', search: '搜索模型名称',
    initial: '获取此提供商可用的模型列表', initialHint: '支持 OpenAI 兼容接口；也可切换到手动输入。',
    failure: '暂时无法获取模型列表', failureHint: '请检查 Base URL、API Key 和网络，或切换到手动输入继续添加。',
    empty: '提供商未返回模型，可使用手动输入。', noMatch: '没有匹配的模型',
    names: '模型名称', namesHelp: '每行一个，也可用逗号分隔。名称须与提供商的模型 ID 完全一致。',
    placeholder: 'model-name-1\nmodel-name-2\nmodel-name-3', selected: '已选择', available: '可选',
    selectAll: '全选当前结果', clear: '清空选择', existing: '已添加',
    connectionHint: '新模型复制此提供商的 Base URL 和 API Key；后续可单独编辑。',
    missing: '请先在提供商配置中填写 Base URL 和 API Key。', edit: '编辑提供商',
    limit: '单次最多 200 个模型。已有模型会跳过，重复输入只添加一次。',
    overLimit: '选择超过 200 个，请减少后再添加。', nameTooLong: '模型名称不能超过 100 个字符。',
    add: '添加', unit: '个模型', back: '返回列表', adding: '正在添加…',
    error: '批量添加失败，请检查提供商配置后重试。', done: '已添加', skipped: '已跳过',
    providerSaved: '提供商已保存', doneHint: '模型已保存，可返回列表查看或继续添加。', continue: '继续添加',
  },
  'en-US': {
    batch: 'Add models in bulk', next: 'Save and add models', connection: 'Connection', selection: 'Select models',
    urlHelp: 'Enter the API base address, including required paths such as /v1. New models copy this address.',
    keyHelp: 'Bulk imports copy this key. Leave blank when editing to keep the saved key.',
    intro: 'Fetch models from your provider or enter their names.', remote: 'Fetch and select', manual: 'Enter manually',
    fetch: 'Fetch models', fetching: 'Fetching…', retry: 'Fetch again', search: 'Search model names',
    initial: 'Fetch the available models from this provider', initialHint: 'Supports OpenAI-compatible APIs. Manual entry is also available.',
    failure: 'Unable to fetch models', failureHint: 'Check the Base URL, API Key and network, or use manual entry to continue.',
    empty: 'The provider returned no models. Use manual entry.', noMatch: 'No matching models',
    names: 'Model names', namesHelp: 'One per line, or comma separated. Use the exact model IDs from your provider.',
    placeholder: 'model-name-1\nmodel-name-2\nmodel-name-3', selected: 'Selected', available: 'Available',
    selectAll: 'Select visible results', clear: 'Clear selection', existing: 'Already added',
    connectionHint: 'New models copy this provider’s Base URL and API Key. You can edit each model later.',
    missing: 'Set the provider’s Base URL and API Key first.', edit: 'Edit provider',
    limit: 'Up to 200 models per batch. Existing models and repeated names are skipped.',
    overLimit: 'More than 200 selected. Reduce the selection to continue.', nameTooLong: 'Model names must be at most 100 characters.',
    add: 'Add', unit: 'models', back: 'Back to list', adding: 'Adding…',
    error: 'Unable to add models. Check the provider configuration and retry.', done: 'Added', skipped: 'Skipped',
    providerSaved: 'Provider saved', doneHint: 'Models saved. Return to the list or add more.', continue: 'Add more',
  },
};

export function useModelImportCopy() {
  const { locale } = useI18n();
  return computed(() => messages[locale.value]);
}
