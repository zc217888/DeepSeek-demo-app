import { useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { currentProvider, officialProvider } from '../../services/api/provider.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setApiKey, setCustomApiKey } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

/** 输入 API Key 后先用 GET /models 校验，通过才保存；official 是官方 DeepSeek，custom 是自定义服务商 */
export const useApiKeyForm = (onSaved?: () => void, target: 'official' | 'custom' = 'official') => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      // 官方 Key 永远按官方接口校验；自定义 Key 按当前协议与地址校验，都走 GET /models
      await verifyApiKey(target === 'official' ? officialProvider(apiKey) : { ...currentProvider(), apiKey })
      ;(target === 'official' ? setApiKey : setCustomApiKey)(apiKey)
      setValue('')
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit }
}
