import {ref} from 'vue'
import {t} from '../i18n'

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
  /**
   * 进行中态：不显示按钮，也不响应 Enter / Esc / 遮罩关闭，由调用方在操作结束后关闭。
   *
   * <p>用于「整树删除 / 整库清空」这类耗时随数据规模增长的操作：没有它，用户只能盯着
   * 一个看起来卡死的界面猜。</p>
   */
  loading?: boolean
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
  /** 打开弹窗的唯一实现：confirm / notice / busy 只在「按钮组合」上有差别。 */
  const show = (optionsOrMessage: string | ConfirmOptions, overrides: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      const opts: ConfirmOptions = typeof optionsOrMessage === 'string'
        ? {content: optionsOrMessage}
        : optionsOrMessage;

      state.value = {
        isOpen: true,
        options: {
          ...defaultOptions,
          title: t('common.tip'),
          confirmText: t('common.confirm'),
          cancelText: t('common.cancel'),
          ...opts,
          ...overrides,
          content: opts.content || opts.message || ''
        },
        resolve
      }
    })
  }

  const confirm = (optionsOrMessage: string | ConfirmOptions): Promise<boolean> => show(optionsOrMessage, {})

  /**
   * 提示框：只有一个「确定」，不关心返回值。
   *
   * <p><b>为什么不用 `window.alert`</b>：标题由 Electron 按 app name 填（历史包名会一路漏到
   * 用户脸上）、样式与主题脱钩、阻塞渲染线程，而且进不了本项目的模态策略用例。</p>
   */
  const notice = async (optionsOrMessage: string | ConfirmOptions): Promise<void> => {
    await show(optionsOrMessage, {showCancel: false})
  }

  /**
   * 进行中提示：不可确认、不可取消，操作结束后调用返回的函数关闭。
   *
   * @returns 关闭函数（务必放在 finally 里）
   */
  const busy = (optionsOrMessage: string | ConfirmOptions): (() => void) => {
    const opts: ConfirmOptions = typeof optionsOrMessage === 'string'
      ? {content: optionsOrMessage}
      : optionsOrMessage
    state.value = {
      isOpen: true,
      options: {
        ...defaultOptions,
        title: t('common.tip'),
        confirmText: t('common.confirm'),
        cancelText: t('common.cancel'),
        ...opts,
        showCancel: false,
        loading: true,
        content: opts.content || opts.message || ''
      },
      // 进行中态没有「结果」可返回，不留悬空的 resolve
      resolve: null
    }
    return () => {
      state.value = {...state.value, isOpen: false, resolve: null}
    }
  }

  const handleConfirm = () => {
    // 进行中态不允许被 Enter / 点击确认掉
    if (state.value.options.loading) return
    if (state.value.resolve) {
      state.value.resolve(true)
    }
    state.value.isOpen = false
    state.value.resolve = null
  }

  const handleCancel = () => {
    if (state.value.options.loading) return
    if (state.value.resolve) {
      state.value.resolve(false)
    }
    state.value.isOpen = false
    state.value.resolve = null
  }

  return {
    state,
    confirm,
    notice,
    busy,
    handleConfirm,
    handleCancel
  }
}
