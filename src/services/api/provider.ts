import { useSettings } from '../settings.js'
import { ApiError, request } from './http.js'

/** 构建期 API 地址，默认 https://api.deepseek.com */
export const API_ORIGIN = __API_ORIGIN__

/** 支持的接口协议：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses */
export type ApiProtocol = 'anthropic' | 'openai-chat' | 'openai-responses'

/** 各协议的默认模型 */
export const DEFAULT_MODEL: Record<ApiProtocol, string> = {
  anthropic: 'deepseek-flash',
  'openai-chat': 'gpt-4o-mini',
  'openai-responses': 'gpt-4o-mini',
}

/** 一个服务商的完整配置：协议决定请求与响应格式，base 为归一化后的接口根地址 */
export type ProviderConfig = {
  protocol: ApiProtocol
  /** 归一化后的接口根地址，带版本段（如 …/v1、…/anthropic/v1） */
  base: string
  apiKey: string
  model: string
}

const trimUrl = (url: string) => url.trim().replace(/\/+$/, '')

const hasVersionSegment = (url: string) => /\/v\d+(?:[a-z]*\d*)?$/i.test(url)

/**
 * 归一化 Base URL：
 * - Anthropic：已带版本段（…/v1、…/anthropic/v1）原样使用，否则补 /anthropic/v1
 *   （DeepSeek 的 Anthropic 兼容接口就在 /anthropic/v1 下）
 * - OpenAI 系：已带版本段原样使用，否则补 /v1
 */
export const resolveBase = (protocol: ApiProtocol, baseUrl: string): string => {
  const raw = trimUrl(baseUrl) || API_ORIGIN
  if (hasVersionSegment(raw)) {
    return raw
  }
  return protocol === 'anthropic' ? `${raw}/anthropic/v1` : `${raw}/v1`
}

/** 展示给用户看的默认地址（不带协议路径），空值时用它做占位提示 */
export const defaultBaseUrl = (protocol: ApiProtocol) =>
  protocol === 'anthropic' ? API_ORIGIN : 'https://api.openai.com'

const isDeepSeekHost = (base: string) => /(^|\.)deepseek\.com$/.test(new URL(base).hostname)

/** 鉴权头：Anthropic 用 x-api-key（官方接口还要 anthropic-version），OpenAI 系用 Bearer */
export const authHeaders = (cfg: Pick<ProviderConfig, 'protocol' | 'base' | 'apiKey'>) => {
  if (cfg.protocol === 'anthropic') {
    return {
      'x-api-key': cfg.apiKey,
      Authorization: `Bearer ${cfg.apiKey}`,
      // 官方 Anthropic 接口必须带版本号，DeepSeek 兼容接口不认这个头，就不发
      ...(isDeepSeekHost(cfg.base) ? {} : { 'anthropic-version': '2023-06-01' }),
    }
  }
  return { Authorization: `Bearer ${cfg.apiKey}` }
}

/**
 * 官方 DeepSeek 配置：Anthropic 协议、官方地址、官方 API Key，与自定义服务商完全独立。
 * 传入 apiKey 用于保存前的校验。
 */
export const officialProvider = (apiKey?: string): ProviderConfig => ({
  protocol: 'anthropic',
  base: resolveBase('anthropic', ''),
  apiKey: apiKey ?? useSettings.getState().apiKey ?? '',
  model: DEFAULT_MODEL.anthropic,
})

/** 从本机设置读出当前生效的服务商配置；model 为空时回落到协议默认模型 */
export const currentProvider = (): ProviderConfig => {
  const state = useSettings.getState()
  if (state.providerMode === 'official') {
    return officialProvider()
  }
  return {
    protocol: state.protocol,
    base: resolveBase(state.protocol, state.baseUrl),
    apiKey: state.customApiKey ?? '',
    model: state.model.trim() || DEFAULT_MODEL[state.protocol],
  }
}

/** GET /models 不支持时的兜底：部分服务商把模型挂在别的路径，值不值得重试交给调用方决定 */
type ModelListBody = {
  data?: unknown
  models?: unknown
}

const pickModelId = (item: unknown): string | null => {
  if (typeof item === 'string') {
    return item
  }
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const { id, name, model } = item as { id?: unknown; name?: unknown; model?: unknown }
  const value = [id, name, model].find((candidate) => typeof candidate === 'string')
  // Gemini 兼容层返回 models/gemini-2.5-pro 这种带前缀的名字
  return typeof value === 'string' ? value.replace(/^models\//, '') : null
}

/** 拉取可用模型列表，去重并按字母序排列 */
export const fetchModels = async (
  cfg: Pick<ProviderConfig, 'protocol' | 'base' | 'apiKey'>,
  signal?: AbortSignal
): Promise<string[]> => {
  const response = await request(`${cfg.base}/models`, {
    method: 'GET',
    headers: authHeaders(cfg),
    signal,
  })
  let body: ModelListBody
  try {
    body = (await response.json()) as ModelListBody
  } catch {
    throw new ApiError('protocol', 'Invalid JSON')
  }
  const source = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
  const ids = source
    .map(pickModelId)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}
