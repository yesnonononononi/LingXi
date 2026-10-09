import { computed, ref } from 'vue';
import { AgentAPI } from '../services/agent';
import { isOk } from '../utils/api';

export function useChatImageAttachments() {
  const attachments = ref<Array<{ file: File; preview: string }>>([]);
  const maxImages = ref<number | null>(null);
  const limitsLoading = ref(false);
  const limitsError = ref('');
  const attachmentError = ref('');
  const canAttach = computed(() => maxImages.value !== null && !limitsLoading.value);

  const loadLimits = async () => {
    limitsLoading.value = true;
    limitsError.value = '';
    try {
      const result = await AgentAPI.chatLimits();
      const limit = result.data?.maxImages;
      if (!isOk(result.code) || !Number.isSafeInteger(limit) || limit == null || limit < 1) {
        throw new Error(result.errMsg || '图片数量限制读取失败');
      }
      maxImages.value = limit;
    } catch (error) {
      maxImages.value = null;
      limitsError.value = error instanceof Error ? error.message : '图片数量限制读取失败';
    } finally {
      limitsLoading.value = false;
    }
  };

  const addImages = (files: File[]) => {
    attachmentError.value = '';
    if (!canAttach.value) {
      attachmentError.value = '图片上传暂不可用，请重试读取数量限制';
      return;
    }
    const images = files.filter(file => file.type.startsWith('image/'));
    if (images.length !== files.length) {
      attachmentError.value = '只支持上传图片文件';
      return;
    }
    if (attachments.value.length + images.length > maxImages.value!) {
      attachmentError.value = `每条消息最多上传 ${maxImages.value} 张图片，请减少选择数量`;
      return;
    }
    attachments.value.push(...images.map(file => ({ file, preview: URL.createObjectURL(file) })));
  };

  const removeImage = (index: number) => {
    const [removed] = attachments.value.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.preview);
    attachmentError.value = '';
  };

  const clearImages = () => {
    attachments.value.forEach(image => URL.revokeObjectURL(image.preview));
    attachments.value = [];
    attachmentError.value = '';
  };

  return { attachments, maxImages, limitsLoading, limitsError, attachmentError, canAttach, loadLimits, addImages, removeImage, clearImages };
}

/** 用户气泡需要跨历史对账存活，不能沿用输入区会立即释放的预览地址。 */
export function readImagePreviews(files: File[]): Promise<string[]> {
  return Promise.all(files.map(file => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片预览读取失败'));
    reader.readAsDataURL(file);
  })));
}
