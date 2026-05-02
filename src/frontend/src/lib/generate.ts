// Polling-based generation client. The backend runs a detached, resumable
// pipeline; we just kick it off (POST) and read state (GET).

export type GenerationStatus =
  | 'queued'
  | 'planning'
  | 'submitting_datasets'
  | 'awaiting_datasets'
  | 'writing_schema'
  | 'writing_prompt'
  | 'submitting_runs'
  | 'awaiting_runs'
  | 'completed'
  | 'failed'
  | 'cancelled'
  // Legacy values still present in any partially-migrated DB rows
  | 'generating_datasets'
  | 'generating_runs'

export type GenerationState = {
  id: string | null
  status: GenerationStatus | null
  archetype: string | null
  instances: string[] | null
  datasets_done: number
  runs_done: number
  prompt_id: string | null
  error: string | null
  error_step: string | null
  started_at: string | null
  updated_at: string | null
  completed_at: string | null
}

type TokenGetter = () => Promise<string | null>

async function authedJson<T>(
  path: string,
  init: RequestInit,
  getToken: TokenGetter,
): Promise<T> {
  const token = await getToken()
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)

  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return (await res.json()) as T
}

export function startGeneration(
  projectId: string,
  getToken: TokenGetter,
): Promise<GenerationState> {
  return authedJson<GenerationState>(
    `/api/projects/${projectId}/generate`,
    { method: 'POST' },
    getToken,
  )
}

export function fetchGenerationState(
  projectId: string,
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<GenerationState> {
  return authedJson<GenerationState>(
    `/api/projects/${projectId}/generation`,
    { method: 'GET', signal },
    getToken,
  )
}

// --------------------------------------------------------------------------- //
// Chat (unchanged — text streaming for the SPOP assistant)
// --------------------------------------------------------------------------- //

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export async function* streamChat(
  projectId: string,
  messages: ChatMessage[],
  getToken: TokenGetter,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const token = await getToken()
  const res = await fetch(`/api/projects/${projectId}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages }),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    yield decoder.decode(value, { stream: true })
  }
}
