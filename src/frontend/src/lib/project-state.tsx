/* eslint-disable react-refresh/only-export-components */
import { useAuth } from '@clerk/clerk-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useApi, type Project } from '@/lib/api'
import {
  fetchGenerationState,
  startGeneration as startGenerationApi,
  type GenerationState,
  type GenerationStatus,
} from '@/lib/generate'
import type { RunConfig } from '@/components/new-run-dialog'
import {
  createSwarmRun,
  listSwarmRuns,
  type RunStatus,
  type SwarmRunSummary,
} from '@/lib/swarm'

// --------------------------------------------------------------------------- //
// Playground runs (API-backed: source of truth is `swarm_runs` in Postgres)
// --------------------------------------------------------------------------- //

export type PlaygroundRun = {
  id: string
  created_at: number
  config: RunConfig
  status?: RunStatus
  current_turn?: number
  best_score?: number | null
}

function summaryToPlaygroundRun(s: SwarmRunSummary): PlaygroundRun {
  return {
    id: s.id,
    created_at: new Date(s.created_at).getTime(),
    config: s.config as RunConfig,
    status: s.status,
    current_turn: s.current_turn,
    best_score: s.best_score,
  }
}

// --------------------------------------------------------------------------- //
// Public types (unchanged shape — UI components keep working)
// --------------------------------------------------------------------------- //

export type DatasetCard = {
  idx: number
  id?: string
  title: string
  preview?: string
  char_count?: number
  status: 'pending' | 'done'
}

export type PromptArtifact = {
  id?: string
  version: number
  system_text: string
  user_template: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output_schema: Record<string, any>
  notes: string | null
}

export type RunArtifact = {
  id?: string
  status: 'idle' | 'pending' | 'done' | 'failed'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structured_output?: Record<string, any>
  error?: string
  tokens_in?: number
  tokens_out?: number
  latency_ms?: number
  model?: string
}

export type SpopMessage = {
  id: string
  role: 'spop' | 'user' | 'assistant'
  content: string
  pending?: boolean
}

type State = {
  project: Project | null
  loading: boolean
  error: string | null
  datasets: DatasetCard[]
  prompt: PromptArtifact | null
  runs: Record<number, RunArtifact>
  generation: GenerationState | null
  generating: boolean
  generationError: string | null
  spopMessages: SpopMessage[]
  playgroundRuns: PlaygroundRun[]
  addPlaygroundRun: (config: RunConfig) => Promise<PlaygroundRun | null>
  refreshPlaygroundRuns: () => Promise<void>
  startGeneration: () => void
  appendChat: (msg: SpopMessage) => void
  patchChat: (id: string, patch: Partial<SpopMessage>) => void
  setProject: React.Dispatch<React.SetStateAction<Project | null>>
}

const Ctx = createContext<State | null>(null)

const IN_FLIGHT: GenerationStatus[] = [
  'queued',
  'planning',
  'submitting_datasets',
  'awaiting_datasets',
  'writing_schema',
  'writing_prompt',
  'submitting_runs',
  'awaiting_runs',
  // legacy
  'generating_datasets',
  'generating_runs',
]

// Polling drives the pipeline forward (each GET lazy-advances). 2s is a
// pleasant cadence and won't hammer Vercel function invocations.
const POLL_INTERVAL_MS = 2000
const GREETING =
  "hi im spop, let me set up your swarm optimisation project now"

let _msgCounter = 0
function newId(prefix: string): string {
  _msgCounter += 1
  return `${prefix}_${Date.now()}_${_msgCounter}`
}

// --------------------------------------------------------------------------- //
// Provider
// --------------------------------------------------------------------------- //

export function ProjectStateProvider({
  projectId,
  children,
}: {
  projectId: string
  children: React.ReactNode
}) {
  const api = useApi()
  const { getToken } = useAuth()

  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [datasets, setDatasets] = useState<DatasetCard[]>([])
  const [prompt, setPrompt] = useState<PromptArtifact | null>(null)
  const [runs, setRuns] = useState<Record<number, RunArtifact>>({})
  const [generation, setGeneration] = useState<GenerationState | null>(null)
  const [generationError, setGenerationError] = useState<string | null>(null)

  const [spopMessages, setSpopMessages] = useState<SpopMessage[]>([
    { id: 'greeting', role: 'spop', content: GREETING },
  ])

  const [playgroundRuns, setPlaygroundRuns] = useState<PlaygroundRun[]>([])

  // Snapshots for narration diffing — separate from React state because we
  // only care about transitions between polls, not re-renders.
  const lastSnapshot = useRef<{
    status: GenerationStatus | null
    archetype: string | null
    instances_emitted: boolean
    datasets_done: number
    runs_done: number
    prompt_announced: boolean
  }>({
    status: null,
    archetype: null,
    instances_emitted: false,
    datasets_done: 0,
    runs_done: 0,
    prompt_announced: false,
  })

  const autoStartedRef = useRef(false)

  const generating = generation?.status
    ? IN_FLIGHT.includes(generation.status)
    : false

  const appendChat = useCallback((msg: SpopMessage) => {
    setSpopMessages((cur) => [...cur, msg])
  }, [])

  const patchChat = useCallback((id: string, patch: Partial<SpopMessage>) => {
    setSpopMessages((cur) =>
      cur.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    )
  }, [])

  // Load project + persisted artifacts + initial generation state on mount
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setDatasets([])
    setPrompt(null)
    setRuns({})
    setGeneration(null)
    setGenerationError(null)
    setSpopMessages([{ id: 'greeting', role: 'spop', content: GREETING }])
    setPlaygroundRuns([])
    autoStartedRef.current = false
    lastSnapshot.current = {
      status: null,
      archetype: null,
      instances_emitted: false,
      datasets_done: 0,
      runs_done: 0,
      prompt_announced: false,
    }

    Promise.all([
      api.getProject(projectId),
      fetchJson<DatasetSummary[]>(`/api/projects/${projectId}/datasets`, getToken),
      fetchJson<PromptArtifact | null>(`/api/projects/${projectId}/prompt`, getToken),
      fetchJson<RunSummary[]>(`/api/projects/${projectId}/runs`, getToken),
      fetchGenerationState(projectId, getToken).catch(() => null),
      listSwarmRuns(projectId, getToken).catch(() => [] as SwarmRunSummary[]),
    ])
      .then(([p, ds, pr, rs, gen, swarmRuns]) => {
        if (cancelled) return
        setProject(p)
        setDatasets(buildDatasetCards(ds, gen))
        setPrompt(pr)
        setRuns(buildRunsMap(rs))
        if (gen) setGeneration(gen)
        setPlaygroundRuns(swarmRuns.map(summaryToPlaygroundRun))
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [api, getToken, projectId])

  const refreshArtifacts = useCallback(async () => {
    const [ds, pr, rs] = await Promise.all([
      fetchJson<DatasetSummary[]>(`/api/projects/${projectId}/datasets`, getToken),
      fetchJson<PromptArtifact | null>(`/api/projects/${projectId}/prompt`, getToken),
      fetchJson<RunSummary[]>(`/api/projects/${projectId}/runs`, getToken),
    ])
    setDatasets((prev) => reconcileDatasets(prev, buildDatasetCards(ds, null)))
    setPrompt(pr)
    setRuns(buildRunsMap(rs))
  }, [getToken, projectId])

  // Drive polling off the project status alone, not the full `generation`
  // object. Otherwise every successful poll sets a new generation reference,
  // tears down this effect, and restarts the loop — which collapses the
  // 1.5s sleep and hammers the API.
  const projectStatus = project?.status
  useEffect(() => {
    if (loading || error || !project) return
    // Poll while the project itself is in-flight; the runner is the source
    // of truth for whether work continues.
    if (projectStatus !== 'pending' && projectStatus !== 'generating') return

    let cancelled = false
    let lastDatasetsDone = -1
    let lastRunsDone = -1
    let lastPromptId: string | null = null
    let lastStatus: GenerationStatus | null = null

    const tick = async () => {
      while (!cancelled) {
        try {
          const next = await fetchGenerationState(projectId, getToken)
          if (cancelled) return

          handleStateDiff(next, lastSnapshot.current, {
            appendChat,
            setProject,
          })
          lastSnapshot.current = {
            status: next.status,
            archetype: next.archetype,
            instances_emitted:
              lastSnapshot.current.instances_emitted ||
              !!(next.archetype && next.instances?.length),
            datasets_done: next.datasets_done,
            runs_done: next.runs_done,
            prompt_announced:
              lastSnapshot.current.prompt_announced || !!next.prompt_id,
          }
          setGeneration(next)

          // Only re-pull artifacts when something material changed.
          const materialChanged =
            next.datasets_done !== lastDatasetsDone ||
            next.runs_done !== lastRunsDone ||
            next.prompt_id !== lastPromptId ||
            next.status !== lastStatus
          lastDatasetsDone = next.datasets_done
          lastRunsDone = next.runs_done
          lastPromptId = next.prompt_id
          lastStatus = next.status

          if (materialChanged) {
            await refreshArtifacts()
          }

          if (
            next.status === 'completed' ||
            next.status === 'failed' ||
            next.status === 'cancelled'
          ) {
            return
          }
        } catch (e) {
          if (!cancelled) {
            setGenerationError(e instanceof Error ? e.message : 'Polling error')
          }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }
    }
    tick()
    return () => {
      cancelled = true
    }
    // Effect deps intentionally exclude `generation` itself: we drive polling
    // off project lifecycle status only, so the loop stays alive across all
    // generation state updates.
  }, [
    appendChat,
    error,
    getToken,
    loading,
    project,
    projectId,
    projectStatus,
    refreshArtifacts,
  ])

  const startGeneration = useCallback(async () => {
    setGenerationError(null)
    setSpopMessages((cur) =>
      cur.length <= 1
        ? [
            ...cur,
            {
              id: newId('spop'),
              role: 'spop',
              content:
                'Spinning up the swarm — picking the document archetype, then **10 example variations** in parallel.',
            },
          ]
        : cur,
    )
    try {
      const next = await startGenerationApi(projectId, getToken)
      setGeneration(next)
      setProject((p) => (p ? { ...p, status: 'generating' } : p))
    } catch (e) {
      setGenerationError(e instanceof Error ? e.message : 'Failed to start')
    }
  }, [getToken, projectId])

  // Auto-start on mount if the project is `pending` (fresh) or `generating`
  // (was interrupted). The backend dedupes — if a runner already exists for
  // this project, POST is a no-op that returns current state.
  useEffect(() => {
    if (loading || error || !project) return
    if (autoStartedRef.current) return
    const status = generation?.status ?? null
    const projectStatus = project.status

    if (
      projectStatus === 'pending' ||
      projectStatus === 'generating' ||
      (status && IN_FLIGHT.includes(status))
    ) {
      autoStartedRef.current = true
      startGeneration()
    }
  }, [loading, error, project, generation, startGeneration])

  const refreshPlaygroundRuns = useCallback(async () => {
    try {
      const runs = await listSwarmRuns(projectId, getToken)
      setPlaygroundRuns(runs.map(summaryToPlaygroundRun))
    } catch {
      /* surface elsewhere if needed */
    }
  }, [getToken, projectId])

  const addPlaygroundRun = useCallback(
    async (config: RunConfig): Promise<PlaygroundRun | null> => {
      try {
        const created = await createSwarmRun(projectId, config, getToken)
        const pgRun = summaryToPlaygroundRun(created)
        setPlaygroundRuns((prev) => [pgRun, ...prev])
        return pgRun
      } catch {
        return null
      }
    },
    [getToken, projectId],
  )

  const value = useMemo<State>(
    () => ({
      project,
      loading,
      error,
      datasets,
      prompt,
      runs,
      generation,
      generating,
      generationError,
      spopMessages,
      playgroundRuns,
      addPlaygroundRun,
      refreshPlaygroundRuns,
      startGeneration,
      appendChat,
      patchChat,
      setProject,
    }),
    [
      project,
      loading,
      error,
      datasets,
      prompt,
      runs,
      generation,
      generating,
      generationError,
      spopMessages,
      playgroundRuns,
      addPlaygroundRun,
      refreshPlaygroundRuns,
      startGeneration,
      appendChat,
      patchChat,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useProjectState(): State {
  const v = useContext(Ctx)
  if (!v) throw new Error('useProjectState used outside ProjectStateProvider')
  return v
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

type DatasetSummary = {
  id: string
  idx: number
  title: string
  token_count: number | null
  created_at: string
}

type RunSummary = {
  id: string
  dataset_id: string
  dataset_idx: number
  prompt_id: string
  model: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structured_output: Record<string, any> | null
  tokens_in: number | null
  tokens_out: number | null
  latency_ms: number | null
  error: string | null
  created_at: string
}

async function fetchJson<T>(
  url: string,
  getToken: () => Promise<string | null>,
): Promise<T> {
  const token = await getToken()
  const res = await fetch(url, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
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
  return res.json()
}

function buildDatasetCards(
  ds: DatasetSummary[],
  gen: GenerationState | null,
): DatasetCard[] {
  const done = new Map(
    ds.map((d) => [
      d.idx,
      {
        idx: d.idx,
        id: d.id,
        title: d.title,
        char_count: d.token_count ? d.token_count * 4 : undefined,
        status: 'done' as const,
      },
    ]),
  )
  // If a job is in flight (or we know there are 10 instances), pre-fill
  // the missing slots as pending so the grid shows all 10 cards.
  const expectPending =
    gen?.status &&
    IN_FLIGHT.includes(gen.status) &&
    gen.status !== 'completed'
  if (!expectPending && done.size === 0) return []
  const cards: DatasetCard[] = []
  for (let i = 1; i <= 10; i++) {
    const existing = done.get(i)
    if (existing) cards.push(existing)
    else if (expectPending)
      cards.push({ idx: i, title: '', status: 'pending' })
  }
  return cards
}

function reconcileDatasets(
  prev: DatasetCard[],
  next: DatasetCard[],
): DatasetCard[] {
  // Preserve `preview` we may have seen via the (now-removed) stream — but
  // since we no longer stream previews, just take next as-is.
  if (prev.length !== next.length) return next
  for (let i = 0; i < next.length; i++) {
    if (prev[i].idx !== next[i].idx) return next
    if (prev[i].status !== next[i].status) return next
    if (prev[i].title !== next[i].title) return next
  }
  return prev
}

function buildRunsMap(rs: RunSummary[]): Record<number, RunArtifact> {
  const m: Record<number, RunArtifact> = {}
  for (const r of rs) {
    m[r.dataset_idx] = {
      id: r.id,
      status: r.error ? 'failed' : 'done',
      structured_output: r.structured_output ?? undefined,
      error: r.error ?? undefined,
      tokens_in: r.tokens_in ?? undefined,
      tokens_out: r.tokens_out ?? undefined,
      latency_ms: r.latency_ms ?? undefined,
      model: r.model,
    }
  }
  return m
}

// --------------------------------------------------------------------------- //
// Narration — derive chat messages from polled state diffs
// --------------------------------------------------------------------------- //

function handleStateDiff(
  next: GenerationState,
  prev: typeof Ctx extends never ? never : {
    status: GenerationStatus | null
    archetype: string | null
    instances_emitted: boolean
    datasets_done: number
    runs_done: number
    prompt_announced: boolean
  },
  helpers: {
    appendChat: (m: SpopMessage) => void
    setProject: React.Dispatch<React.SetStateAction<Project | null>>
  },
) {
  const { appendChat, setProject } = helpers

  // Status transitions
  if (prev.status !== next.status) {
    if (next.status === 'planning' && prev.status !== 'planning') {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content:
          'Choosing the document archetype and **10 example variations** — same central theme, different specifics.',
      })
    }
    if (
      next.status === 'submitting_datasets' &&
      prev.status !== 'submitting_datasets' &&
      prev.status !== 'awaiting_datasets'
    ) {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content:
          'Submitting all 10 dataset generations to Anthropic Batch — running in parallel, results land back together.',
      })
    }
    if (
      next.status === 'writing_schema' &&
      prev.status !== 'writing_schema' &&
      prev.status !== 'writing_prompt'
    ) {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content:
          'All 10 datasets in. Designing the **structured output schema** (10+ fields, some nested).',
      })
    }
    if (next.status === 'writing_prompt' && prev.status !== 'writing_prompt') {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content: 'Schema drafted. Writing the extraction **prompt**.',
      })
    }
    if (
      next.status === 'submitting_runs' &&
      prev.status !== 'submitting_runs' &&
      prev.status !== 'awaiting_runs'
    ) {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content:
          'Prompt ready. Submitting **10 extraction runs** to Batch — outputs will appear on each card.',
      })
    }
    // Legacy synchronous-runner states (still present in older DB rows)
    if (
      next.status === 'generating_datasets' &&
      prev.status !== 'generating_datasets'
    ) {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content: 'Launching **10 agents** in parallel — one per example.',
      })
    }
    if (
      next.status === 'generating_runs' &&
      prev.status !== 'generating_runs'
    ) {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content:
          'Prompt ready. Running it against all 10 datasets — outputs will appear on each card.',
      })
    }
    if (next.status === 'completed' && prev.status !== 'completed') {
      setProject((p) => (p ? { ...p, status: 'ready' } : p))
      const elapsed =
        next.started_at && next.completed_at
          ? (new Date(next.completed_at).getTime() -
              new Date(next.started_at).getTime()) /
            1000
          : null
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content: elapsed
          ? `**Project setup complete** in ${elapsed.toFixed(1)}s. Ask me anything about the datasets, schema, prompt, or outputs.`
          : '**Project setup complete.** Ask me anything about the datasets, schema, prompt, or outputs.',
      })
    }
    if (next.status === 'failed' && prev.status !== 'failed') {
      setProject((p) => (p ? { ...p, status: 'failed' } : p))
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content: `Generation failed${next.error_step ? ` at step **${next.error_step}**` : ''}: ${next.error ?? 'unknown error'}`,
      })
    }
  }

  // Archetype + instances first appearance
  if (
    !prev.instances_emitted &&
    next.archetype &&
    next.instances?.length
  ) {
    appendChat({
      id: newId('spop'),
      role: 'spop',
      content:
        `**Archetype**\n\n${next.archetype}\n\n**Examples**\n\n` +
        next.instances.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    })
  }

  // Dataset progress (announce each new completion in narration)
  if (next.datasets_done > prev.datasets_done) {
    const delta = next.datasets_done - prev.datasets_done
    if (delta === 1) {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content: `Dataset **${next.datasets_done}/10** ready.`,
      })
    } else {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content: `**${next.datasets_done}/10** datasets ready.`,
      })
    }
  }

  // Prompt creation
  if (!prev.prompt_announced && next.prompt_id) {
    appendChat({
      id: newId('spop'),
      role: 'spop',
      content: '**Prompt** drafted. Open the Prompt tab to inspect it.',
    })
  }

  // Run progress
  if (next.runs_done > prev.runs_done) {
    const delta = next.runs_done - prev.runs_done
    if (delta === 1) {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content: `Output **${next.runs_done}/10** ready.`,
      })
    } else {
      appendChat({
        id: newId('spop'),
        role: 'spop',
        content: `**${next.runs_done}/10** outputs ready.`,
      })
    }
  }
}
