import { ref } from 'vue'
import { t } from '../i18n'

export type ConfirmType = 'info' | 'warning' | 'danger' | 'success'

export interface ConfirmOptions {
  title?: string
  content?: string
  message?: string
  preview?: string
  type?: ConfirmType
  confirmText?: string
  cancelText?: string
  showCancel?: boolean
  colors?: string[]
  glowColor?: string
  backgroundColor?: string
  borderRadius?: number
}

interface ConfirmState {
  isOpen: boolean
  options: ConfirmOptions
  resolve: ((value: boolean) => void) | null
}

// 与语言相关的默认文案在 confirm() 调用时按当前语言组装，保证切换语言后新弹窗即时生效。
const defaultOptions: ConfirmOptions = {
  type: 'info',
  content: '',
  showCancel: true,
  borderRadius: 20
}

const state = ref<ConfirmState>({
  isOpen: false,
  options: {
    ...defaultOptions,
    title: t('common.tip'),
    confirmText: t('common.confirm'),
    cancelText: t('common.cancel')
  },
  resolve: null
})

export function useConfirm() {
  const confirm = (optionsOrMessage: string | ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      let opts: ConfirmOptions = {}
      if (typeof optionsOrMessage === 'string') {
        opts = { content: optionsOrMessage }
      } else {
        opts = optionsOrMessage
      }

      state.value = {
        isOpen: true,
        options: {
          ...defaultOptions,
          title: t('common.tip'),
          confirmText: t('common.confirm'),
          cancelText: t('common.cancel'),
          ...opts,
          content: opts.content || opts.message || ''
        },
        resolve
      }
    })
  }

  const handleConfirm = () => {
    if (state.value.resolve) {
      state.value.resolve(true)
    }
    state.value.isOpen = false
    state.value.resolve = null
  }

  const handleCancel = () => {
    if (state.value.resolve) {
      state.value.resolve(false)
    }
    state.value.isOpen = false
    state.value.resolve = null
  }

  return {
    state,
    confirm,
    handleConfirm,
    handleCancel
  }
}
