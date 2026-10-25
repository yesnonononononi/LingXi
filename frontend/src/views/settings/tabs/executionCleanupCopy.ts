import { computed } from 'vue';
import { useI18n } from '../../../i18n';

const messages = {
  'zh-CN': {
    title: '清理无用执行数据',
    description: '回收已结束且没有业务引用的执行记录，保留历史重发、挂起恢复与后台任务所需数据。',
    count: (value: string) => `预计可清理 ${value} 条`,
    loading: '正在检查…', cleaning: '正在清理…', refresh: '重新检查', action: '清理',
    success: (value: string) => `已清理 ${value} 条执行记录`,
    loadError: '无法检查可清理数据，请重试', cleanupError: '清理失败，请重新检查后重试',
    contractError: '执行数据清理接口返回不完整',
  },
  'en-US': {
    title: 'Clean up unused execution data',
    description: 'Remove finished execution records with no business references. Keep data needed for editing and resending history, resuming paused work, and background tasks.',
    count: (value: string) => `${value} records may be removed`,
    loading: 'Checking…', cleaning: 'Cleaning…', refresh: 'Check again', action: 'Clean up',
    success: (value: string) => `Removed ${value} execution records`,
    loadError: 'Unable to check unused execution data. Please retry.',
    cleanupError: 'Cleanup failed. Check again before retrying.',
    contractError: 'Incomplete execution cleanup response',
  },
};

export function useExecutionCleanupCopy() {
  const { locale } = useI18n();
  return computed(() => messages[locale.value]);
}
