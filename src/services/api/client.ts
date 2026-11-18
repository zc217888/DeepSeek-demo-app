import { readMessageEvent } from './parseEvent.js'
import { ApiError, isErrorBody, readErrorResponse, request } from './http.js'
import { streamChatCompletions, streamResponses } from './openai.js'
import { authHeaders, type ProviderConfig } from './provider.js'
import { readServerSentEvents } from './sse.js'
import type { CreateMessageRequest, FileObject, FilePurpose, MessageStreamEvent } from './types.js'

export { ApiError } from './http.js'
export type { ApiErrorKind } from './http.js'
export { API_ORIGIN } from './provider.js'
export { request } from './http.js'

/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

const anthropicHeaders = (cfg: ProviderConfig, beta: boolean): Record<string, string> => ({
  ...authHeaders(cfg),
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验配置（不产生费用） */
export const verifyApiKey = async (
  cfg: Pick<ProviderConfig, 'protocol' | 'base' | 'apiKey'>,
  signal?: AbortSignal
): Promise<void> => {
  await request(`${cfg.base}/models`, {
    method: 'GET',
    headers: authHeaders(cfg),
    signal,
  })
}

/**
 * POST {base}/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  cfg: ProviderConfig,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${cfg.base}/files`, {
    method: 'POST',
    headers: anthropicHeaders(cfg, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE {base}/files/{file_id} */
export const deleteFile = async (cfg: ProviderConfig, fileId: string): Promise<void> => {
  await request(`${cfg.base}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(cfg, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST {base}/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
async function* streamAnthropicMessage(
  cfg: ProviderConfig,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${cfg.base}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(cfg, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

/**
 * 按当前协议请求生成：三者都归一成 Anthropic 事件流，上层渲染逻辑不用区分协议。
 * OpenAI 系协议不支持联网搜索、文件上传与标题生成，相关字段会被适配器忽略。
 */
export function streamMessage(
  cfg: ProviderConfig,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const prompt = {
    model: cfg.model || body.model,
    system: body.system,
    messages: body.messages,
  }
  switch (cfg.protocol) {
    case 'openai-chat':
      return streamChatCompletions(cfg, prompt, signal)
    case 'openai-responses':
      return streamResponses(cfg, prompt, signal)
    default:
      return streamAnthropicMessage({ ...cfg, model: cfg.model || body.model }, body, signal)
  }
}
