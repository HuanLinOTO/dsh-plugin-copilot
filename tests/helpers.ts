/** Shared test helpers: message builders and SSE event streams. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { SseEvent } from '../src/wire/shared.ts'

/** Minimal harness message for serializer tests (only role/content are read). */
export function msg(role: Message['role'], content: ContentBlock[]): Message {
  if (role === 'user') {
    return createUserMessage({ content, source: { kind: 'user' } }) as Message
  }
  return { id: `msg-${Math.random().toString(36).slice(2)}`, role, content, source: { kind: 'user' } } as Message
}

/** Turn a list of SSE data payloads into the event stream the translators consume. */
export async function* sseEvents(payloads: readonly string[]): AsyncGenerator<SseEvent> {
  for (const data of payloads) {
    yield { event: data === '[DONE]' ? '' : 'message', data }
  }
}

/** Turn `(event, data)` pairs into an event stream (responses/messages protocols). */
export async function* ssePairs(pairs: readonly (readonly [string, string])[]): AsyncGenerator<SseEvent> {
  for (const [event, data] of pairs) {
    yield { event, data }
  }
}

/** Collect an async iterable into an array. */
export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of items) out.push(item)
  return out
}
