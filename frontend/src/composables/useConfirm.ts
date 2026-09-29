import { ref } from 'vue'

export type ConfirmType = 'info' | 'warning' | 'danger' | 'success'

export interface ConfirmOptions {
  title?: string
  content?: string
  message?: string
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

const defaultOptions: ConfirmOptions = {
  title: '提示',
  content: '',
  type: 'info',
  confirmText: '确定',
  cancelText: '取消',
  showCancel: true,
  borderRadius: 20
}

const state = ref<ConfirmState>({
  isOpen: false,
  options: { ...defaultOptions },
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
