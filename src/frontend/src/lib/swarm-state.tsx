/* eslint-disable react-refresh/only-export-components */
import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  getSwarmRun,
  pauseSwarmRun,
  startSwarmRun,
  streamSwarm,
  type LayoutPoint,
  type RunStatus,
  type SwarmAttempt,
  type SwarmAttemptSnapshot,
  type SwarmEvent,
  type SwarmRunDetail,
} from '@/lib/swarm'

export type AgentTickerState = {
  agent_idx: number
  attempt_id: string | null
  parent_attempt_id: string | null
  parent_score: number | null
  status: 'idle' | 'started' | 'sampling' | 'drafting' | 'scoring' | 'done' | 'failed'
  current_score: number | null
  error: string | null
}

export type SwarmRunState = {
  loading: boolean
  error: string | null
  run: SwarmRunDetail | null
  status: RunStatus | null
  currentTurn: number
  bestAttempt: {
    id: string
    score: number
    system_text: string
    user_template: string
  } | null
  attempts: SwarmAttempt[]                // every attempt seen so far
  layout: Map<string, { x: number; y: number }>
  agents: AgentTickerState[]              // live row per agent_idx for this turn
  scoresByTurn: Record<number, number[]>  // {turn: [score per agent]}
  start: () => Promise<void>
  pause: () => Promise<void>
}

const DEFAULT_RUN_STATE: Omit<SwarmRunState, 'start' | 'pause'> = {
  loading: true,
  error: null,
  run: null,
  status: null,
  currentTurn: 0,
  bestAttempt: null,
  attempts: [],
  layout: new Map(),
  agents: [],
  scoresByTurn: {},
}

function _agentsFromRun(numAgents: number): AgentTickerState[] {
  return Array.from({ length: numAgents }, (_, i) => ({
    agent_idx: i,
    attempt_id: null,
    parent_attempt_id: null,
    parent_score: null,
    status: 'idle' as const,
    current_score: null,
    error: null,
  }))
}

function _snapshotToAttempt(s: SwarmAttemptSnapshot): SwarmAttempt {
  return {
    id: s.id,
    turn: s.turn,
    agent_idx: s.agent_idx,
    parent_attempt_id: s.parent_attempt_id,
    status: s.status,
    score: s.score,
    pheromone: s.pheromone,
    x: s.x,
    y: s.y,
    system_text: null,
    user_template: null,
    predicted_output: null,
    error: s.error,
  }
}

export function useSwarmRun(
  projectId: string | null,
  runId: string | null,
): SwarmRunState {
  const { getToken } = useAuth()
  const [state, setState] = useState(DEFAULT_RUN_STATE)
  const abortRef = useRef<AbortController | null>(null)

  const apply = useCallback(
    (mut: (prev: typeof DEFAULT_RUN_STATE) => typeof DEFAULT_RUN_STATE) => {
      setState((prev) => mut(prev))
    },
    [],
  )

  // Subscribe / re-subscribe whenever (project, run) changes.
  useEffect(() => {
    if (!projectId || !runId) {
      setState({ ...DEFAULT_RUN_STATE, loading: false })
      return
    }
    setState({ ...DEFAULT_RUN_STATE, loading: true })

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let cancelled = false

    ;(async () => {
      try {
        // Initial detail fetch — gives us config + best prompt body.
        const detail = await getSwarmRun(projectId, runId, getToken)
        if (cancelled) return
        apply((p) => ({
          ...p,
          loading: false,
          run: detail,
          status: detail.status,
          currentTurn: detail.current_turn,
          bestAttempt:
            detail.best_attempt_id &&
            detail.best_system_text !== null &&
            detail.best_user_template !== null &&
            detail.best_score !== null
              ? {
                  id: detail.best_attempt_id,
                  score: detail.best_score,
                  system_text: detail.best_system_text,
                  user_template: detail.best_user_template,
                }
              : null,
          agents: _agentsFromRun(detail.config.num_agents),
        }))

        for await (const ev of streamSwarm(projectId, runId, getToken, ctrl.signal)) {
          if (cancelled) break
          apply((p) => _reduce(p, ev))
        }
      } catch (e) {
        if (cancelled) return
        if ((e as Error).name === 'AbortError') return
        apply((p) => ({ ...p, loading: false, error: (e as Error).message }))
      }
    })()

    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [projectId, runId, getToken, apply])

  const start = useCallback(async () => {
    if (!projectId || !runId) return
    const r = await startSwarmRun(projectId, runId, getToken)
    apply((p) => ({ ...p, status: r.status }))
  }, [projectId, runId, getToken, apply])

  const pause = useCallback(async () => {
    if (!projectId || !runId) return
    const r = await pauseSwarmRun(projectId, runId, getToken)
    apply((p) => ({ ...p, status: r.status }))
  }, [projectId, runId, getToken, apply])

  return useMemo(
    () => ({ ...state, start, pause }),
    [state, start, pause],
  )
}

// --------------------------------------------------------------------------- //
// Reducer
// --------------------------------------------------------------------------- //

function _setAgent(
  agents: AgentTickerState[],
  idx: number,
  patch: Partial<AgentTickerState>,
): AgentTickerState[] {
  if (idx < 0 || idx >= agents.length) return agents
  const next = agents.slice()
  next[idx] = { ...next[idx], ...patch }
  return next
}

function _upsertAttempt(
  attempts: SwarmAttempt[],
  patch: Partial<SwarmAttempt> & { id: string; turn: number; agent_idx: number },
): SwarmAttempt[] {
  const i = attempts.findIndex((a) => a.id === patch.id)
  if (i >= 0) {
    const next = attempts.slice()
    next[i] = { ...next[i], ...patch }
    return next
  }
  return [
    ...attempts,
    {
      id: patch.id,
      turn: patch.turn,
      agent_idx: patch.agent_idx,
      parent_attempt_id: patch.parent_attempt_id ?? null,
      status: patch.status ?? 'pending',
      score: patch.score ?? null,
      pheromone: patch.pheromone ?? 0,
      x: patch.x ?? null,
      y: patch.y ?? null,
      system_text: patch.system_text ?? null,
      user_template: patch.user_template ?? null,
      predicted_output: patch.predicted_output ?? null,
      error: patch.error ?? null,
    },
  ]
}

function _reduce(
  prev: typeof DEFAULT_RUN_STATE,
  ev: SwarmEvent,
): typeof DEFAULT_RUN_STATE {
  switch (ev.type) {
    case 'snapshot': {
      const layout = new Map<string, { x: number; y: number }>()
      const attempts = ev.attempts.map(_snapshotToAttempt)
      for (const a of ev.attempts) {
        if (a.x !== null && a.y !== null) layout.set(a.id, { x: a.x, y: a.y })
      }
      const scoresByTurn: Record<number, number[]> = {}
      for (const a of ev.attempts) {
        if (a.score === null) continue
        ;(scoresByTurn[a.turn] ||= []).push(a.score)
      }
      const numAgents =
        prev.run?.config.num_agents ?? prev.agents.length ?? 0
      return {
        ...prev,
        attempts,
        layout,
        scoresByTurn,
        status: (ev.run.status as RunStatus | undefined) ?? prev.status,
        currentTurn:
          typeof ev.run.current_turn === 'number'
            ? ev.run.current_turn
            : prev.currentTurn,
        bestAttempt: ev.best
          ? {
              id: ev.best.id,
              score: ev.best.score,
              system_text: ev.best.system_text,
              user_template: ev.best.user_template,
            }
          : prev.bestAttempt,
        agents: prev.agents.length === numAgents ? prev.agents : _agentsFromRun(numAgents),
      }
    }
    case 'turn_started': {
      return {
        ...prev,
        status: 'running',
        currentTurn: ev.turn,
        agents: prev.agents.map((a) => ({
          ...a,
          attempt_id: null,
          parent_attempt_id: null,
          parent_score: null,
          status: 'idle',
          current_score: null,
          error: null,
        })),
      }
    }
    case 'agent_started': {
      return {
        ...prev,
        agents: _setAgent(prev.agents, ev.agent_idx, {
          attempt_id: ev.attempt_id,
          parent_attempt_id: ev.parent_attempt_id,
          parent_score: ev.parent_score,
          status: 'started',
          current_score: null,
          error: null,
        }),
        attempts: _upsertAttempt(prev.attempts, {
          id: ev.attempt_id,
          turn: ev.turn,
          agent_idx: ev.agent_idx,
          parent_attempt_id: ev.parent_attempt_id,
          status: 'pending',
          score: null,
          pheromone: 0,
        }),
      }
    }
    case 'agent_progress': {
      return {
        ...prev,
        agents: _setAgent(prev.agents, ev.agent_idx, {
          status: ev.phase as AgentTickerState['status'],
        }),
      }
    }
    case 'agent_drafted': {
      return {
        ...prev,
        attempts: _upsertAttempt(prev.attempts, {
          id: ev.attempt_id,
          turn: ev.turn,
          agent_idx: ev.agent_idx,
          status: 'drafting',
        }),
      }
    }
    case 'agent_scored': {
      const updated = _upsertAttempt(prev.attempts, {
        id: ev.attempt_id,
        turn: ev.turn,
        agent_idx: ev.agent_idx,
        status: 'done',
        score: ev.score,
        pheromone: ev.pheromone,
        predicted_output: ev.predicted_output,
      })
      const turnScores = (prev.scoresByTurn[ev.turn] || []).slice()
      turnScores.push(ev.score)
      return {
        ...prev,
        agents: _setAgent(prev.agents, ev.agent_idx, {
          status: 'done',
          current_score: ev.score,
        }),
        attempts: updated,
        scoresByTurn: { ...prev.scoresByTurn, [ev.turn]: turnScores },
      }
    }
    case 'agent_failed': {
      return {
        ...prev,
        agents: _setAgent(prev.agents, ev.agent_idx, {
          status: 'failed',
          error: ev.error,
        }),
        attempts: _upsertAttempt(prev.attempts, {
          id: ev.attempt_id,
          turn: ev.turn,
          agent_idx: ev.agent_idx,
          status: 'failed',
          error: ev.error,
        }),
      }
    }
    case 'relayout': {
      const layout = new Map(prev.layout)
      for (const p of ev.points as LayoutPoint[]) {
        layout.set(p.id, { x: p.x, y: p.y })
      }
      const attempts = prev.attempts.map((a) => {
        const xy = layout.get(a.id)
        return xy ? { ...a, x: xy.x, y: xy.y } : a
      })
      return { ...prev, layout, attempts }
    }
    case 'turn_complete': {
      return {
        ...prev,
        currentTurn: ev.turn,
      }
    }
    case 'best_updated': {
      return {
        ...prev,
        bestAttempt: {
          id: ev.attempt_id,
          score: ev.score,
          system_text: ev.system_text,
          user_template: ev.user_template,
        },
      }
    }
    case 'paused':
      return { ...prev, status: 'paused' }
    case 'completed':
      return { ...prev, status: 'completed' }
    case 'error':
      return { ...prev, status: 'failed', error: ev.message }
    default:
      return prev
  }
}
