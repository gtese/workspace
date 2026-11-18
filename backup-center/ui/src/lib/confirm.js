import { reactive } from 'vue'

export const confirmState = reactive({
  open: false,
  title: '请确认',
  message: '',
  detail: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
  _resolve: null,
})

/**
 * 打开确认弹窗，返回 Promise<boolean>。
 * @param {{title?:string,message?:string,detail?:string,confirmText?:string,cancelText?:string,danger?:boolean}} options
 */
export function confirm(options = {}) {
  confirmState.title = options.title || '请确认'
  confirmState.message = options.message || ''
  confirmState.detail = options.detail || ''
  confirmState.confirmText = options.confirmText || '确定'
  confirmState.cancelText = options.cancelText || '取消'
  confirmState.danger = !!options.danger
  confirmState.open = true
  return new Promise((resolve) => {
    confirmState._resolve = resolve
  })
}

export function resolveConfirm(value) {
  const resolve = confirmState._resolve
  confirmState.open = false
  confirmState._resolve = null
  if (resolve) resolve(value)
}
