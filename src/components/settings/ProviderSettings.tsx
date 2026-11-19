import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconEditOutline16, IconRefreshOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { ApiError } from '../../services/api/http.js'
import {
  DEFAULT_MODEL,
  defaultBaseUrl,
  fetchModels,
  resolveBase,
  type ApiProtocol,
} from '../../services/api/provider.js'
import {
  setBaseUrl,
  setModel,
  setProtocol,
  setProviderMode,
  useSettings,
  type ProviderMode,
} from '../../services/settings.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import styles from './Settings.module.css'

const protocols: { value: ApiProtocol; label: TranslationKey }[] = [
  { value: 'anthropic', label: 'protocolAnthropic' },
  { value: 'openai-chat', label: 'protocolOpenAiChat' },
  { value: 'openai-responses', label: 'protocolOpenAiResponses' },
]

const modes: { value: ProviderMode; label: TranslationKey }[] = [
  { value: 'official', label: 'providerModeOfficial' },
  { value: 'custom', label: 'providerModeCustom' },
]

/** 一行：左侧标题与说明，右侧控件 */
const Row = ({
  label,
  description,
  error,
  children,
  className,
}: {
  label: string
  description?: string
  error?: string | null
  children: ReactNode
  className?: string
}) => (
  <div className={clsx(styles.cell, styles.row, className)}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      {error ? (
        <div className={styles.error}>{error}</div>
      ) : description ? (
        <div className={styles.description}>{description}</div>
      ) : null}
    </div>
    {children}
  </div>
)

/** 单行文本输入：回车或失焦保存，样式与 API Key 输入框一致 */
const InlineInput = ({
  value,
  placeholder,
  ariaLabel,
  onSave,
  autoFocus = false,
}: {
  value: string
  placeholder: string
  ariaLabel: string
  onSave: (value: string) => void
  autoFocus?: boolean
}) => {
  const [draft, setDraft] = useState(value)
  const commit = () => {
    if (draft.trim() !== value.trim()) {
      onSave(draft.trim())
    }
  }
  return (
    <div className={clsx(styles.apiKeyInput, styles.providerInput)}>
      <input
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

/** 服务商设置：官方 DeepSeek 与自定义服务商两套独立配置；自定义含协议、地址、模型（可自动获取）、独立 Key */
export const ProviderSettings = () => {
  const t = useTranslate()
  const mode = useSettings((state) => state.providerMode)
  const protocol = useSettings((state) => state.protocol)
  const baseUrl = useSettings((state) => state.baseUrl)
  const model = useSettings((state) => state.model)
  const customApiKey = useSettings((state) => state.customApiKey)
  const customKeyEditor = useApiKeyEditor('custom')
  const [models, setModels] = useState<string[]>([])
  const [editingModel, setEditingModel] = useState(false)
  const [loading, setLoading] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)

  const currentModel = model.trim() || DEFAULT_MODEL[protocol]

  const onFetchModels = async () => {
    if (loading) {
      return
    }
    if (!customApiKey) {
      setModelError(t('providerNeedApiKey'))
      return
    }
    setLoading(true)
    setModelError(null)
    try {
      const list = await fetchModels({
        protocol,
        base: resolveBase(protocol, baseUrl),
        apiKey: customApiKey,
      })
      if (list.length === 0) {
        setModelError(t('providerModelsEmpty'))
        return
      }
      setModels(list)
      setEditingModel(false)
      if (!list.includes(currentModel)) {
        setModel(list[0])
      }
    } catch (error) {
      setModelError(
        error instanceof ApiError && error.status === 401
          ? t('apiKeyInvalid')
          : t('providerModelsFailed')
      )
      showToast({ key: 'providerModelsFailed', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const modelOptions = models.includes(currentModel)
    ? models.map((id) => ({ value: id, label: id }))
    : [{ value: currentModel, label: currentModel }, ...models.map((id) => ({ value: id, label: id }))]

  return (
    <>
      <Row
        label={t('providerMode')}
        description={mode === 'official' ? t('providerModeOfficialDescription') : t('providerModeCustomDescription')}
      >
        <Select
          ariaLabel={t('providerMode')}
          value={mode}
          options={modes.map((item) => ({ value: item.value, label: t(item.label) }))}
          onChange={(value) => {
            setProviderMode(value)
            setModels([])
            setModelError(null)
          }}
        />
      </Row>
      {mode === 'official' ? null : (
        <>
          <ApiKeyField editor={customKeyEditor} labelKey="providerCustomApiKey" />
          <ApiKeyConfirm editor={customKeyEditor} />
          <Row label={t('providerProtocol')} description={t('providerProtocolDescription')}>
            <Select
              ariaLabel={t('providerProtocol')}
              value={protocol}
              options={protocols.map((item) => ({ value: item.value, label: t(item.label) }))}
              onChange={(value) => {
                setProtocol(value)
                setModels([])
                setModelError(null)
              }}
            />
          </Row>
          <Row
            label={t('providerBaseUrl')}
            description={t('providerBaseUrlDescription', { url: defaultBaseUrl(protocol) })}
          >
            <InlineInput
              key={`base-${protocol}`}
              ariaLabel={t('providerBaseUrl')}
              value={baseUrl}
              placeholder={defaultBaseUrl(protocol)}
              onSave={setBaseUrl}
            />
          </Row>
          <Row
            label={t('providerModel')}
            description={t('providerModelLimitation')}
            error={modelError}
          >
            {models.length > 0 && !editingModel ? (
              <div className={styles.providerModelRow}>
                <Select
                  ariaLabel={t('providerModel')}
                  value={currentModel}
                  options={modelOptions}
                  onChange={setModel}
                  className={styles.providerModelSelect}
                />
                <IconButton
                  tone="primary"
                  icon={<IconEditOutline16 />}
                  tooltip={t('providerModelEdit')}
                  onClick={() => setEditingModel(true)}
                />
              </div>
            ) : (
              <div className={styles.providerModelRow}>
                <InlineInput
                  key={`model-${protocol}`}
                  ariaLabel={t('providerModel')}
                  value={model}
                  placeholder={DEFAULT_MODEL[protocol]}
                  onSave={(value) => setModel(value)}
                />
                <IconButton
                  tone="primary"
                  icon={<IconRefreshOutline16 />}
                  tooltip={loading ? t('providerModelsFetching') : t('providerModelsFetch')}
                  disabled={loading || !customApiKey}
                  onClick={() => void onFetchModels()}
                />
              </div>
            )}
          </Row>
        </>
      )}
    </>
  )
}
