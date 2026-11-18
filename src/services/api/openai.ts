import { ApiError, isErrorBody, readErrorResponse, request } from './http.js'
import type { ProviderConfig } from './provider.js'
import { authHeaders } from './provider.js'
import { readServerSentEvents } from './sse.js'
import type { MessageParam, MessageStreamEvent, StopReason } from './types.js'

/** 与协议无关的请求素材：系统提示、对话历史、模型 */
export type PromptRequest = {
  model: string
  system: string
  messages: MessageParam[]
}

type FlatMessage = { role: 'user' | 'assistant'; text: string }

/**
 * 把 Anthropic 形态的消息拍平成纯文本对话：去掉 latest_reminder 扩展角色、
 * 思考块、工具块与文件块，只保留正文。附件在非 Anthropic 协议下不可用。
 */
export const flattenMessages = (messages: MessageParam[]): FlatMessage[] => {
  const readText = (content: string | { type: string; text?: string }[]) =>
    typeof content === 'string'
      ? content
      : content
          .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
          .join('\n')
  const flat: FlatMessage[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      continue
    }
    const text = readText(message.content as string | { type: string; text?: string }[])
    if (message.role === 'assistant' && !text.trim()) {
      continue
    }
    flat.push({ role: message.role, text })
  }
  return flat
}

const mapStopReason = (reason: string | null | undefined): StopReason => {
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

/** 逐块累积输出的状态机：每类内容（思考/正文）只建一个块，交错到达时复用同一块 */
class BlockWriter {
  private next = 0
  private started = false
  private indexes = new Map<'text' | 'thinking', number>()

  constructor(
    private readonly model: string,
    private readonly id: string
  ) {}

  *begin(): Generator<MessageStreamEvent> {
    if (this.started) {
      return
    }
    this.started = true
    yield { type: 'message_start', message: { id: this.id, model: this.model } }
  }

  *delta(type: 'text' | 'thinking', value: string): Generator<MessageStreamEvent> {
    if (!value) {
      return
    }
    let index = this.indexes.get(type)
    if (index === undefined) {
      index = this.next++
      this.indexes.set(type, index)
      yield {
        type: 'content_block_start',
        index,
        content_block:
          type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' },
      }
    }
    yield {
      type: 'content_block_delta',
      index,
      delta: type === 'text' ? { type: 'text_delta', text: value } : { type: 'thinking_delta', thinking: value },
    }
  }

  *close(): Generator<MessageStreamEvent> {
    for (const [type, index] of this.indexes) {
      if (type === 'thinking') {
        yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: '' } }
      }
      yield { type: 'content_block_stop', index }
    }
    this.indexes.clear()
  }

  get hasContent() {
    return this.started
  }
}

const assertEventStream = async (response: Response): Promise<ReadableStream<Uint8Array>> => {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  return response.body
}

/**
 * OpenAI Chat Completions（POST /chat/completions，stream: true）翻译成 Anthropic 事件流。
 * 兼容 DeepSeek-R1、OpenRouter 等以 reasoning_content / reasoning 下发思考内容的实现。
 */
export async function* streamChatCompletions(
  cfg: ProviderConfig,
  prompt: PromptRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(cfg),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: prompt.model,
      stream: true,
      messages: [
        ...(prompt.system ? [{ role: 'system', content: prompt.system }] : []),
        ...flattenMessages(prompt.messages),
      ],
    }),
    signal,
  })
  const stream = await assertEventStream(response)

  const writer = new BlockWriter(prompt.model, `chatcmpl-${Date.now()}`)
  let stopReason: StopReason = 'end_turn'
  for await (const { data } of readServerSentEvents(stream, signal)) {
    if (data === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    yield* writer.begin()
    const choice = (payload as { choices?: { delta?: Record<string, string>; finish_reason?: string | null }[] })
      .choices?.[0]
    const delta = choice?.delta ?? {}
    const thinking = delta.reasoning_content ?? delta.reasoning
    if (typeof thinking === 'string') {
      yield* writer.delta('thinking', thinking)
    }
    if (typeof delta.content === 'string') {
      yield* writer.delta('text', delta.content)
    }
    if (choice?.finish_reason) {
      stopReason = mapStopReason(choice.finish_reason)
    }
  }
  if (!writer.hasContent) {
    throw new ApiError('interrupted', '')
  }
  yield* writer.close()
  yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null } }
  yield { type: 'message_stop' }
}

/**
 * OpenAI Responses（POST /responses，stream: true）翻译成 Anthropic 事件流。
 * 文本走 response.output_text.delta，思考摘要走 response.reasoning_*_text.delta。
 */
export async function* streamResponses(
  cfg: ProviderConfig,
  prompt: PromptRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${cfg.base}/responses`, {
    method: 'POST',
    headers: {
      ...authHeaders(cfg),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: prompt.model,
      stream: true,
      ...(prompt.system ? { instructions: prompt.system } : {}),
      input: flattenMessages(prompt.messages).map(({ role, text }) => ({ role, content: text })),
    }),
    signal,
  })
  const stream = await assertEventStream(response)

  const writer = new BlockWriter(prompt.model, `resp-${Date.now()}`)
  let stopReason: StopReason = 'end_turn'
  for await (const { data } of readServerSentEvents(stream, signal)) {
    if (data === '[DONE]') {
      break
    }
    let payload: { type?: string; delta?: string; response?: { usage?: { output_tokens?: number } } }
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    const event = payload.type ?? ''
    if (event === 'error' || event === 'response.failed') {
      const message = (payload as { error?: { message?: string }; response?: { error?: { message?: string } } })
      throw new ApiError('stream', message.error?.message ?? message.response?.error?.message ?? 'error')
    }
    if (event === 'response.created' || event === 'response.in_progress') {
      yield* writer.begin()
      continue
    }
    if (event === 'response.output_text.delta' && typeof payload.delta === 'string') {
      yield* writer.begin()
      yield* writer.delta('text', payload.delta)
      continue
    }
    if (
      (event === 'response.reasoning_summary_text.delta' ||
        event === 'response.reasoning_text.delta') &&
      typeof payload.delta === 'string'
    ) {
      yield* writer.begin()
      yield* writer.delta('thinking', payload.delta)
      continue
    }
    if (event === 'response.incomplete') {
      stopReason = 'max_tokens'
      continue
    }
    if (event === 'response.completed') {
      yield* writer.begin()
      break
    }
  }
  if (!writer.hasContent) {
    throw new ApiError('interrupted', '')
  }
  yield* writer.close()
  yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null } }
  yield { type: 'message_stop' }
}
