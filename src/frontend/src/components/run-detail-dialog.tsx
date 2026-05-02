import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Beaker,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  TriangleAlert,
  X,
} from 'lucide-react'

import { SwarmMap } from '@/components/swarm-map'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useSwarmRun, type AgentTickerState } from '@/lib/swarm-state'
import type { RunStatus } from '@/lib/swarm'
import { cn } from '@/lib/utils'

type Props = {
  projectId: string | null
  runId: string | null
  onClose: () => void
}

const STATUS_TONE: Record<RunStatus, string> = {
  idle: 'bg-muted text-muted-foreground',
  running: 'bg-chart-2/20 text-chart-2',
  paused: 'bg-chart-3/20 text-chart-3',
  completed: 'bg-chart-1/20 text-chart-1',
  failed: 'bg-destructive/15 text-destructive',
}

const SWARM_LABEL = {
  aco: 'Ant Colony',
  pso: 'Particle Swarm',
  abc: 'Bee Colony',
  firefly: 'Firefly',
} as const

const MODEL_LABEL = {
  'claude-opus-4-7': 'Opus 4.7',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5': 'Haiku 4.5',
} as const

export function RunDetailDialog({ projectId, runId, onClose }: Props) {
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null)
  const dialogRef = useCallback((el: HTMLDialogElement | null) => {
    setDialogEl(el)
  }, [])
  const open = runId !== null

  useEffect(() => {
    if (!dialogEl) return
    if (open && !dialogEl.open) dialogEl.showModal()
    if (!open && dialogEl.open) dialogEl.close()
  }, [open, dialogEl])

  const swarm = useSwarmRun(projectId, runId)
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)

  // Reset selection when the run changes
  useEffect(() => {
    setSelectedAttemptId(null)
  }, [runId])

  const inspectedAttempt = useMemo(() => {
    if (selectedAttemptId) {
      return swarm.attempts.find((a) => a.id === selectedAttemptId) ?? null
    }
    if (swarm.bestAttempt) {
      return {
        id: swarm.bestAttempt.id,
        system_text: swarm.bestAttempt.system_text,
        user_template: swarm.bestAttempt.user_template,
        score: swarm.bestAttempt.score,
        turn: null as number | null,
        agent_idx: null as number | null,
      }
    }
    return null
  }, [selectedAttemptId, swarm.attempts, swarm.bestAttempt])

  const status = swarm.status ?? 'idle'
  const isRunning = status === 'running'
  const isBusy = isRunning
  const numAgents = swarm.run?.config.num_agents ?? 0

  const turnHistory = useMemo(() => {
    const turns = Object.keys(swarm.scoresByTurn)
      .map(Number)
      .sort((a, b) => a - b)
    return turns.map((t) => {
      const scores = swarm.scoresByTurn[t]
      const max = scores.length ? Math.max(...scores) : 0
      const mean = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : 0
      return { turn: t, max, mean, count: scores.length }
    })
  }, [swarm.scoresByTurn])

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogEl) onClose()
      }}
      className="fixed inset-0 m-auto h-[90vh] w-[min(1200px,95vw)] rounded-lg border bg-card text-card-foreground p-0 shadow-lg backdrop:bg-foreground/40"
    >
      <div className="flex h-full flex-col">
        {/* Header */}
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-3">
            <Beaker className="size-5 text-muted-foreground" />
            <h2 className="text-base font-semibold">
              {swarm.run ? SWARM_LABEL[swarm.run.config.swarm_type] : 'Swarm run'}
            </h2>
            {swarm.run && (
              <Badge
                variant="outline"
                className={cn('font-mono', STATUS_TONE[status])}
              >
                {status}
              </Badge>
            )}
            {swarm.run && (
              <span className="text-xs text-muted-foreground">
                turn <span className="font-medium tabular-nums">{swarm.currentTurn}</span>
              </span>
            )}
            {swarm.bestAttempt && (
              <span className="text-xs text-muted-foreground">
                best{' '}
                <span className="font-medium tabular-nums text-foreground">
                  {swarm.bestAttempt.score.toFixed(3)}
                </span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!isRunning ? (
              <Button
                size="sm"
                onClick={() => void swarm.start()}
                disabled={swarm.loading || status === 'completed'}
              >
                <Play />
                {swarm.currentTurn === 0 ? 'Start' : 'Resume'}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void swarm.pause()}>
                <Pause />
                Pause
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="size-4" />
            </Button>
          </div>
        </header>

        {/* Param strip */}
        {swarm.run && (
          <div className="grid grid-cols-6 gap-2 border-b bg-muted/30 px-5 py-2 text-[11px]">
            <ParamTile
              label="Model"
              value={MODEL_LABEL[swarm.run.config.model] ?? swarm.run.config.model}
            />
            <ParamTile label="Agents" value={numAgents.toString()} />
            <ParamTile
              label="Randomness ε"
              value={swarm.run.config.randomness.toFixed(2)}
            />
            <ParamTile
              label="Pheromone Q"
              value={swarm.run.config.pheromone_strength.toFixed(2)}
            />
            <ParamTile label="Thought" value={swarm.run.config.thought_level} />
            <ParamTile label="Test sample" value="dataset #10" />
          </div>
        )}

        {swarm.error && (
          <div className="border-b bg-destructive/10 px-5 py-2 text-xs text-destructive">
            {swarm.error}
          </div>
        )}

        {/* Body — map + best prompt */}
        <div className="grid flex-1 grid-cols-12 gap-0 overflow-hidden">
          <div className="col-span-7 border-r overflow-hidden">
            <SwarmMap
              attempts={swarm.attempts}
              layout={swarm.layout}
              bestAttemptId={swarm.bestAttempt?.id ?? null}
              selectedId={selectedAttemptId}
              onSelect={setSelectedAttemptId}
            />
          </div>

          <aside className="col-span-5 flex flex-col overflow-hidden">
            <div className="border-b px-4 py-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {selectedAttemptId ? 'Selected attempt' : 'Best prompt'}
              </span>
              {selectedAttemptId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setSelectedAttemptId(null)}
                >
                  Show best
                </Button>
              )}
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {inspectedAttempt ? (
                <PromptInspector
                  systemText={inspectedAttempt.system_text}
                  userTemplate={inspectedAttempt.user_template}
                  score={inspectedAttempt.score}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No attempts yet. Once an agent finishes scoring, the
                  best prompt will appear here.
                </p>
              )}
            </div>
          </aside>
        </div>

        {/* Agents grid */}
        <div className="border-t bg-background px-5 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Agents · turn {swarm.currentTurn || '—'}
            </span>
            {isBusy && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                working
              </span>
            )}
          </div>
          <div
            className={cn(
              'grid gap-2',
              numAgents <= 4 ? 'grid-cols-4' : numAgents <= 8 ? 'grid-cols-8' : 'grid-cols-12',
            )}
          >
            {swarm.agents.map((a) => (
              <AgentTile key={a.agent_idx} agent={a} />
            ))}
          </div>
        </div>

        {/* Turn history strip */}
        <div className="border-t bg-muted/20 px-5 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Turn history
            </span>
            <span className="text-[10px] text-muted-foreground">
              max&nbsp;score per turn
            </span>
          </div>
          {turnHistory.length === 0 ? (
            <p className="text-xs text-muted-foreground">No turns yet.</p>
          ) : (
            <div className="flex h-12 items-end gap-1">
              {turnHistory.map((t) => (
                <div
                  key={t.turn}
                  className="flex-1 min-w-1 rounded-t bg-chart-1/60 transition-all"
                  style={{ height: `${Math.max(2, t.max * 100)}%` }}
                  title={`turn ${t.turn} · max ${t.max.toFixed(3)} · mean ${t.mean.toFixed(3)} · n=${t.count}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </dialog>
  )
}

function ParamTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-xs font-medium tabular-nums truncate">{value}</div>
    </div>
  )
}

const AGENT_PHASE_LABEL: Record<AgentTickerState['status'], string> = {
  idle: 'idle',
  started: 'starting',
  sampling: 'sampling',
  drafting: 'drafting',
  scoring: 'scoring',
  done: 'done',
  failed: 'failed',
}

function AgentTile({ agent }: { agent: AgentTickerState }) {
  const isWorking =
    agent.status === 'started' ||
    agent.status === 'sampling' ||
    agent.status === 'drafting' ||
    agent.status === 'scoring'
  return (
    <div className="rounded-md border bg-card p-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-medium tabular-nums text-muted-foreground">
          #{agent.agent_idx}
        </span>
        {agent.status === 'done' && (
          <CheckCircle2 className="size-3 text-chart-1" />
        )}
        {agent.status === 'failed' && (
          <TriangleAlert className="size-3 text-destructive" />
        )}
        {isWorking && (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        )}
      </div>
      <div className="mt-0.5 truncate text-muted-foreground">
        {AGENT_PHASE_LABEL[agent.status]}
      </div>
      <div className="mt-1 flex items-baseline justify-between">
        <span className="text-[10px] text-muted-foreground">score</span>
        <span className="font-mono tabular-nums">
          {agent.current_score !== null ? agent.current_score.toFixed(3) : '—'}
        </span>
      </div>
      {agent.parent_score !== null && (
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-muted-foreground">parent</span>
          <span className="font-mono tabular-nums text-muted-foreground">
            {agent.parent_score.toFixed(3)}
          </span>
        </div>
      )}
    </div>
  )
}

function PromptInspector({
  systemText,
  userTemplate,
  score,
}: {
  systemText: string | null
  userTemplate: string | null
  score: number | null
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          score
        </span>
        <span className="font-mono text-sm tabular-nums">
          {score !== null ? score.toFixed(3) : '—'}
        </span>
      </div>
      <Section title="System">
        <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
          {systemText ?? '(not yet drafted)'}
        </pre>
      </Section>
      <Section title="User template">
        <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
          {userTemplate ?? '(not yet drafted)'}
        </pre>
      </Section>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-md border bg-muted/20">
      <header className="border-b px-3 py-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      </header>
      <div className="px-3 py-2">{children}</div>
    </section>
  )
}
