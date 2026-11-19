import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { translate, type TranslationMessage } from '../../i18n/index.js'
import type { ApiErrorBody } from './types.js'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

export const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

export const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

/**
 * 原生 HTTP 请求：APK 里 WebView 的 fetch 会被跨域（CORS）与明文限制拦截，
 * 第三方服务商大多不发 CORS 头。fetch 失败时走 Capacitor 原生通道，绕开这些限制。
 * 原生通道不支持流式，返回的是完整响应体，仅作为兜底。
 */
const nativeResponse = async (url: string, init: RequestInit): Promise<Response> => {
  const headers =
    init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : ((init.headers as Record<string, string> | undefined) ?? {})
  const result = await CapacitorHttp.request({
    url,
    method: (init.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    headers,
    data: typeof init.body === 'string' ? init.body : undefined,
    responseType: 'text',
  })
  return new Response(typeof result.data === 'string' ? result.data : '', {
    status: result.status,
    headers: result.headers,
  })
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    // WebView 跨域/明文拦截表现为 fetch 抛 TypeError，换原生通道重试一次
    if (Capacitor.isNativePlatform() && !(init.body instanceof FormData)) {
      try {
        response = await nativeResponse(url, init)
      } catch (nativeError) {
        if (init.signal?.aborted) {
          throw nativeError
        }
        throw new ApiError('network', nativeError instanceof Error ? nativeError.message : String(nativeError))
      }
    } else {
      throw new ApiError('network', error instanceof Error ? error.message : String(error))
    }
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}
