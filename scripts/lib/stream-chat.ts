/**
 * Streaming chat-completion helper.
 *
 * WHY: DeepInfra silently drops the TCP socket after ~4.5 min on long
 * non-streaming inference, so a big review prompt to GLM-5.2 never returns.
 * Streaming (`stream: true`) keeps the connection alive because GLM-5.2 emits
 * `reasoning_content` deltas throughout the reasoning phase — a 48KB prompt
 * completed in 3m27s streamed where the non-streamed call hung and dropped.
 *
 * This helper POSTs an OpenAI-compatible streaming chat-completion and returns
 * the assembled visible content string (SSE `delta.content`). It IGNORES
 * `delta.reasoning_content` — that keeps the socket warm but is not part of the
 * model's answer. Fetch/timeout errors propagate to the caller (fail-closed).
 */
export async function streamChatCompletion(opts: {
  endpoint: string
  apiKey: string
  body: Record<string, unknown>
  timeoutMs: number
}): Promise<string> {
  const res = await fetch(opts.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ ...opts.body, stream: true }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  })

  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`stream API returned ${res.status}: ${t.slice(0, 200)}`)
  }
  if (!res.body) {
    throw new Error('stream API returned no body')
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''

  // Process a single SSE `data:` line. Returns 'done' when [DONE] is seen so the
  // caller can stop; throws when the payload carries an error envelope.
  function handleLine(rawLine: string): 'done' | 'continue' {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) return 'continue'
    const payload = line.slice('data:'.length).trim()
    if (payload === '[DONE]') return 'done'
    try {
      const json = JSON.parse(payload) as {
        error?: unknown
        choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>
      }
      // A 200 stream can still carry an error envelope mid-stream — surface it
      // instead of silently returning partial/empty content (fail-closed).
      if (json?.error != null) {
        const err = json.error as { message?: unknown }
        const message = typeof err?.message === 'string' ? err.message : JSON.stringify(json.error)
        throw new Error(`stream API returned an error object: ${message}`)
      }
      const delta = json?.choices?.[0]?.delta?.content
      if (typeof delta === 'string') content += delta
    } catch (e) {
      // Re-throw our own error envelope; swallow only genuine parse failures.
      if (e instanceof Error && e.message.startsWith('stream API returned an error object')) {
        throw e
      }
      console.debug('[stream-chat] skipping unparseable SSE data line:', e)
    }
    return 'continue'
  }

  // In Bun, res.body is async-iterable and yields Uint8Array chunks.
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    // Keep the last (possibly partial) line in the buffer for the next chunk.
    buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      if (handleLine(rawLine) === 'done') return content
    }
  }

  // Flush any final buffered line that wasn't newline-terminated.
  if (buffer.length > 0) {
    if (handleLine(buffer) === 'done') return content
  }

  return content
}
