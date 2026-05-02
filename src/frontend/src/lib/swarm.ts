// Swarm-run REST + NDJSON live event consumer.

export type SwarmType = 'aco' | 'pso' | 'abc' | 'firefly'
export type RunModel =
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5'
export type ThoughtLevel = 'minimal' | 'standard' | 'deep' | 'extreme'
export type RunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'

export type SwarmRunConfig = {
  swarm_type: SwarmType
  model: RunModel
  num_agents: number
  thought_level: ThoughtLevel
  randomness: number
  pheromone_strength: number
}

export type SwarmRunSummary = {
  id: string
  project_id: string
  config: SwarmRunConfig
  status: RunStatus
  current_turn: number
  best_score: number | null
  created_at: string
  updated_at: string
}

export type SwarmRunDetail = SwarmRunSummary & {
  best_attempt_id: string | null
  best_system_text: string | null
  best_user_template: string | null
  error: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJson = Record<string, any>

export type SwarmAttempt = {
  id: string
  turn: number
  agent_idx: number
  parent_attempt_id: string | null
  status: string
  score: number | null
  pheromone: number
  x: number | null
  y: number | null
  system_text: string | null
  user_template: string | null
  predicted_output: AnyJson | null
  error: string | null
}

export type SwarmAttemptSnapshot = {
  id: string
  turn: number
  agent_idx: number
  parent_attempt_id: string | null
  status: string
  system_preview: string
  user_preview: string
  score: number | null
  pheromone: number
  x: number | null
  y: number | null
  error: string | null
}

export type LayoutPoint = { id: string; x: number; y: number }

export type SwarmEvent =
  | {
      type: 'snapshot'
      run: SwarmRunDetail | (SwarmRunSummary & { error: string | null })
      attempts: SwarmAttemptSnapshot[]
      best: {
        id: string
        system_text: string
        user_template: string
        score: number
      } | null
      ts: number
    }
  | { type: 'turn_started'; turn: number }
  | {
      type: 'agent_started'
      turn: number
      agent_idx: number
      attempt_id: string
      parent_attempt_id: string | null
      parent_score: number | null
      parent_xy: { x: number; y: number } | null
    }
  | {
      type: 'agent_progress'
      turn: number
      agent_idx: number
      phase: 'sampling' | 'drafting' | 'scoring'
    }
  | {
      type: 'agent_drafted'
      turn: number
      agent_idx: number
      attempt_id: string
      system_preview: string
      user_preview: string
    }
  | {
      type: 'agent_scored'
      turn: number
      agent_idx: number
      attempt_id: string
      score: number
      pheromone: number
      latency_ms: number
      predicted_output: AnyJson
    }
  | {
      type: 'agent_failed'
      turn: number
      agent_idx: number
      attempt_id: string
      error: string
    }
  | { type: 'relayout'; turn: number; points: LayoutPoint[] }
  | {
      type: 'turn_complete'
      turn: number
      scores: number[]
      best_attempt_id: string | null
      best_score: number | null
    }
  | {
      type: 'best_updated'
      attempt_id: string
      score: number
      system_text: string
      user_template: string
    }
  | { type: 'paused' }
  | { type: 'completed' }
  | { type: 'error'; message: string }

type TokenGetter = () => Promise<string | null>

async function authedJson<T>(
  path: string,
  init: RequestInit,
  getToken: TokenGetter,
): Promise<T> {
  const token = await getToken()
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
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
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// --------------------------------------------------------------------------- //
// REST
// --------------------------------------------------------------------------- //

export function listSwarmRuns(
  projectId: string,
  getToken: TokenGetter,
): Promise<SwarmRunSummary[]> {
  return authedJson(
    `/api/projects/${projectId}/swarm-runs`,
    { method: 'GET' },
    getToken,
  )
}

export function createSwarmRun(
  projectId: string,
  config: SwarmRunConfig,
  getToken: TokenGetter,
): Promise<SwarmRunSummary> {
  return authedJson(
    `/api/projects/${projectId}/swarm-runs`,
    { method: 'POST', body: JSON.stringify(config) },
    getToken,
  )
}

export function getSwarmRun(
  projectId: string,
  runId: string,
  getToken: TokenGetter,
): Promise<SwarmRunDetail> {
  return authedJson(
    `/api/projects/${projectId}/swarm-runs/${runId}`,
    { method: 'GET' },
    getToken,
  )
}

export function startSwarmRun(
  projectId: string,
  runId: string,
  getToken: TokenGetter,
): Promise<{ started: boolean; status: RunStatus }> {
  return authedJson(
    `/api/projects/${projectId}/swarm-runs/${runId}/start`,
    { method: 'POST' },
    getToken,
  )
}

export function pauseSwarmRun(
  projectId: string,
  runId: string,
  getToken: TokenGetter,
): Promise<{ status: RunStatus }> {
  return authedJson(
    `/api/projects/${projectId}/swarm-runs/${runId}/pause`,
    { method: 'POST' },
    getToken,
  )
}

export function deleteSwarmRun(
  projectId: string,
  runId: string,
  getToken: TokenGetter,
): Promise<void> {
  return authedJson(
    `/api/projects/${projectId}/swarm-runs/${runId}`,
    { method: 'DELETE' },
    getToken,
  )
}

// --------------------------------------------------------------------------- //
// NDJSON stream
// --------------------------------------------------------------------------- //

async function* readNdjson(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        yield JSON.parse(line)
      } catch {
        /* ignore malformed line */
      }
    }
  }
  buffer = buffer.trim()
  if (buffer) {
    try {
      yield JSON.parse(buffer)
    } catch {
      /* ignore */
    }
  }
}

export async function* streamSwarm(
  projectId: string,
  runId: string,
  getToken: TokenGetter,
  signal?: AbortSignal,
): AsyncGenerator<SwarmEvent> {
  const token = await getToken()
  const res = await fetch(
    `/api/projects/${projectId}/swarm-runs/${runId}/stream`,
    {
      method: 'POST',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal,
    },
  )
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
  for await (const ev of readNdjson(reader)) {
    yield ev as SwarmEvent
  }
}
