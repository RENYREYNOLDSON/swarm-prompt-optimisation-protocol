import { useState } from 'react'
import { useNavigate, useParams, NavLink, Outlet } from 'react-router-dom'
import { Loader2, CheckCircle2, FileText, Trash2, Plus, Beaker } from 'lucide-react'

import { DatasetDetailDialog } from '@/components/dataset-detail-dialog'
import { NewRunDialog, type RunConfig } from '@/components/new-run-dialog'
import { RunDetailDialog } from '@/components/run-detail-dialog'
import { Markdown } from '@/components/markdown'
import { SpopChat } from '@/components/spop-chat'
import { SwarmPlayground } from '@/components/swarm-playground'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAppShell, type AppShellContext } from '@/components/app-shell'
import {
  ProjectStateProvider,
  useProjectState,
} from '@/lib/project-state'
import { useApi, type Project } from '@/lib/api'
import { cn } from '@/lib/utils'

type TabId = 'datasets' | 'prompt' | 'playground' | 'settings'

const TABS: { id: TabId; label: string }[] = [
  { id: 'datasets', label: 'Datasets' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'playground', label: 'Playground' },
  { id: 'settings', label: 'Settings' },
]

const STATUS_LABEL: Record<Project['status'], string> = {
  pending: 'Pending',
  generating: 'Generating',
  ready: 'Ready',
  failed: 'Failed',
}

const STATUS_TONE: Record<Project['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  generating: 'bg-chart-2/15 text-chart-2',
  ready: 'bg-chart-1/15 text-chart-1',
  failed: 'bg-destructive/15 text-destructive',
}

export default function ProjectView() {
  const { id } = useParams<{ id: string }>()
  if (!id) return null
  return (
    <ProjectStateProvider projectId={id}>
      <ProjectShell />
    </ProjectStateProvider>
  )
}

function ProjectShell() {
  const { project, loading, error } = useProjectState()
  const appShell = useAppShell()

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading project…</div>
  }
  if (error) {
    return <div className="p-8 text-sm text-destructive">{error}</div>
  }
  if (!project) {
    return <div className="p-8 text-sm text-muted-foreground">Project not found.</div>
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-8 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_TONE[project.status],
            )}
          >
            {STATUS_LABEL[project.status]}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{project.domain}</p>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="px-8 py-6 space-y-6">
          <SpopChat />

          <div>
            <nav className="flex gap-1 border-b">
              {TABS.map((t) => (
                <NavLink
                  key={t.id}
                  to={t.id}
                  className={({ isActive }) =>
                    cn(
                      'px-3 py-2 text-sm border-b-2 transition-colors -mb-px',
                      isActive
                        ? 'border-foreground text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
            <div className="pt-6">
              <Outlet context={appShell satisfies AppShellContext} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Tabs
// --------------------------------------------------------------------------- //

export function DatasetsTab() {
  const {
    project,
    datasets,
    runs,
    generating,
    generationError,
    startGeneration,
  } = useProjectState()

  const [openIdx, setOpenIdx] = useState<number | null>(null)

  const allDone = datasets.length > 0 && datasets.every((d) => d.status === 'done')
  const showRetry = !generating && project && project.status !== 'ready'
  const retryLabel =
    project?.status === 'generating' ? 'Resume / regenerate' : 'Generate'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {generating
            ? 'Generating in parallel…'
            : allDone
              ? `${datasets.length} datasets ready.`
              : 'No datasets yet.'}
        </p>
        {showRetry && (
          <Button onClick={startGeneration} size="sm">
            {retryLabel}
          </Button>
        )}
      </div>

      {generationError && (
        <p className="text-sm text-destructive">{generationError}</p>
      )}

      {datasets.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <h2 className="text-base font-medium">No datasets yet</h2>
          <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
            Click <strong>Generate</strong> to create 10 sample documents in
            your domain. SPOP will narrate progress in the chat above.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {datasets.map((d) => (
            <DatasetCardView
              key={d.idx}
              idx={d.idx}
              status={d.status}
              title={d.title}
              preview={d.preview}
              charCount={d.char_count}
              run={runs[d.idx]}
              onOpen={() => d.status === 'done' && setOpenIdx(d.idx)}
            />
          ))}
        </div>
      )}

      {project && (
        <DatasetDetailDialog
          projectId={project.id}
          idx={openIdx}
          run={openIdx !== null ? runs[openIdx] : undefined}
          onClose={() => setOpenIdx(null)}
        />
      )}
    </div>
  )
}

function DatasetCardView({
  idx,
  status,
  title,
  preview,
  charCount,
  run,
  onOpen,
}: {
  idx: number
  status: 'pending' | 'done'
  title?: string
  preview?: string
  charCount?: number
  run?: import('@/lib/project-state').RunArtifact
  onOpen?: () => void
}) {
  const clickable = status === 'done' && onOpen
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen?.()
              }
            }
          : undefined
      }
      className={cn(
        'rounded-lg border bg-card p-4 space-y-2 transition-colors',
        status === 'pending' && 'border-dashed bg-muted/40',
        clickable && 'cursor-pointer hover:bg-accent/40 focus:outline-none focus:ring-2 focus:ring-ring/50',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Dataset {idx}/10
        </span>
        {status === 'pending' ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <CheckCircle2 className="size-4 text-chart-1" />
        )}
      </div>
      {status === 'pending' ? (
        <p className="text-sm text-muted-foreground">Generating…</p>
      ) : (
        <>
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          {charCount !== undefined && (
            <p className="text-xs text-muted-foreground">
              {charCount.toLocaleString()} characters
            </p>
          )}
          {preview && (
            <div className="max-h-24 overflow-hidden text-muted-foreground [mask-image:linear-gradient(to_bottom,black_60%,transparent)]">
              <Markdown>{preview}</Markdown>
            </div>
          )}
          <RunBlock run={run} />
        </>
      )}
    </div>
  )
}

function RunBlock({ run }: { run?: import('@/lib/project-state').RunArtifact }) {
  if (!run || run.status === 'idle') return null

  if (run.status === 'pending') {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2">
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Running prompt…</span>
      </div>
    )
  }

  if (run.status === 'failed') {
    return (
      <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
        <p className="text-xs font-semibold text-destructive">Extraction failed</p>
        <p className="mt-0.5 text-xs text-destructive/80">{run.error}</p>
      </div>
    )
  }

  return (
    <details className="group mt-2 overflow-hidden rounded-md border bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/60">
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">Structured output</span>
          {run.tokens_out !== undefined && run.latency_ms !== undefined && (
            <span className="text-[10px] text-muted-foreground/70">
              {run.tokens_out.toLocaleString()} tok · {(run.latency_ms / 1000).toFixed(1)}s
            </span>
          )}
        </span>
        <span className="text-muted-foreground transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <pre className="max-h-80 overflow-auto px-3 pt-1 pb-3 font-mono text-[11px] leading-relaxed">
        {JSON.stringify(run.structured_output, null, 2)}
      </pre>
    </details>
  )
}

export function PromptTab() {
  const { prompt, generating } = useProjectState()

  if (!prompt) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <h2 className="text-base font-medium">No prompt yet</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
          {generating
            ? 'Datasets first, then schema, then prompt — SPOP is working.'
            : 'The structured prompt and its output schema (10+ fields, some nested) will live here once generated.'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Prompt v{prompt.version}</h2>
      </div>

      <PromptSection title="System">
        <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
          {prompt.system_text}
        </pre>
      </PromptSection>

      <PromptSection title="User template">
        <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
          {prompt.user_template}
        </pre>
      </PromptSection>

      <PromptSection title="Output schema (JSON Schema)">
        <pre className="text-xs font-mono leading-relaxed overflow-auto">
          {JSON.stringify(prompt.output_schema, null, 2)}
        </pre>
      </PromptSection>

      {prompt.notes && (
        <PromptSection title="Design notes">
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {prompt.notes}
          </p>
        </PromptSection>
      )}
    </div>
  )
}

function PromptSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border bg-card">
      <header className="border-b px-4 py-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  )
}

const SWARM_LABEL: Record<RunConfig['swarm_type'], string> = {
  aco: 'Ant Colony',
  pso: 'Particle Swarm',
  abc: 'Bee Colony',
  firefly: 'Firefly',
}

const MODEL_LABEL: Record<RunConfig['model'], string> = {
  'claude-opus-4-7': 'Opus 4.7',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5': 'Haiku 4.5',
}

const THOUGHT_LABEL: Record<RunConfig['thought_level'], string> = {
  minimal: 'Minimal',
  standard: 'Standard',
  deep: 'Deep',
  extreme: 'Extreme',
}

export function PlaygroundTab() {
  const { project, playgroundRuns, addPlaygroundRun } = useProjectState()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [openRunId, setOpenRunId] = useState<string | null>(null)

  async function onCreate(config: RunConfig) {
    const created = await addPlaygroundRun(config)
    if (created) setOpenRunId(created.id)
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Runs</h2>
            <p className="text-sm text-muted-foreground">
              Configure a swarm and kick off a run against the generated prompt.
            </p>
          </div>
          <Button onClick={() => setDialogOpen(true)} size="sm">
            <Plus />
            New run
          </Button>
        </div>

        {playgroundRuns.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center">
            <h3 className="text-base font-medium">No runs yet</h3>
            <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
              Click <strong>New run</strong> to configure swarm type, model, and
              hyperparameters.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {playgroundRuns.map((r) => (
              <RunCard key={r.id} run={r} onOpen={() => setOpenRunId(r.id)} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Swarm playground</h2>
          <p className="text-sm text-muted-foreground">
            Mock agent swarms — during real runs this will visualise live agents
            and pheromone trails.
          </p>
        </div>
        <SwarmPlayground />
      </section>

      <NewRunDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={onCreate}
      />

      <RunDetailDialog
        projectId={project?.id ?? null}
        runId={openRunId}
        onClose={() => setOpenRunId(null)}
      />
    </div>
  )
}

function RunCard({
  run,
  onOpen,
}: {
  run: import('@/lib/project-state').PlaygroundRun
  onOpen: () => void
}) {
  const c = run.config
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="rounded-lg border bg-card p-4 space-y-3 cursor-pointer hover:bg-accent/40 focus:outline-none focus:ring-2 focus:ring-ring/50 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Beaker className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{SWARM_LABEL[c.swarm_type]}</span>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {run.status ?? 'idle'}
          {typeof run.current_turn === 'number' && run.current_turn > 0 && (
            <> · turn {run.current_turn}</>
          )}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <RunStat label="Model" value={MODEL_LABEL[c.model]} />
        <RunStat label="Agents" value={c.num_agents.toString()} />
        <RunStat label="Thought" value={THOUGHT_LABEL[c.thought_level]} />
        <RunStat label="Randomness" value={c.randomness.toFixed(2)} />
        <RunStat label="Pheromone" value={c.pheromone_strength.toFixed(2)} />
        {typeof run.best_score === 'number' && (
          <RunStat label="Best score" value={run.best_score.toFixed(3)} />
        )}
      </dl>
    </div>
  )
}

function RunStat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </>
  )
}

export function SettingsTab() {
  const { project } = useProjectState()
  if (!project) return null
  return <SettingsForm key={project.id} project={project} />
}

function SettingsForm({ project }: { project: Project }) {
  const { setProject } = useProjectState()
  const { refreshProjects } = useAppShell()
  const api = useApi()
  const navigate = useNavigate()

  const [name, setName] = useState(project.name)
  const [domain, setDomain] = useState(project.domain)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const trimmedName = name.trim()
  const trimmedDomain = domain.trim()
  const dirty =
    trimmedName !== project.name || trimmedDomain !== project.domain
  const canSave =
    dirty && trimmedName.length > 0 && trimmedDomain.length > 0 && !saving

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      const patch: { name?: string; domain?: string } = {}
      if (trimmedName !== project.name) patch.name = trimmedName
      if (trimmedDomain !== project.domain) patch.domain = trimmedDomain
      const updated = await api.updateProject(project.id, patch)
      setProject(updated)
      setName(updated.name)
      setDomain(updated.domain)
      setSavedAt(Date.now())
      refreshProjects()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  function onReset() {
    setName(project.name)
    setDomain(project.domain)
    setSaveError(null)
  }

  async function onDelete() {
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.deleteProject(project.id)
      refreshProjects()
      navigate('/app', { replace: true })
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete')
      setDeleting(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <form onSubmit={onSave} className="space-y-5 rounded-lg border bg-card p-5">
        <header className="space-y-1">
          <h2 className="text-base font-semibold">General</h2>
          <p className="text-sm text-muted-foreground">
            Update the project name and domain. Existing datasets and prompts
            are not affected.
          </p>
        </header>

        <div className="grid gap-2">
          <Label htmlFor="settings-name">Name</Label>
          <Input
            id="settings-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="settings-domain">Domain</Label>
          <Textarea
            id="settings-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            maxLength={500}
            rows={3}
            required
          />
        </div>

        {saveError && <p className="text-sm text-destructive">{saveError}</p>}

        <div className="flex items-center justify-end gap-2">
          {savedAt && !dirty && !saveError && (
            <span className="text-xs text-muted-foreground mr-auto">Saved.</span>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={onReset}
            disabled={!dirty || saving}
          >
            Reset
          </Button>
          <Button type="submit" disabled={!canSave}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>

      <section className="space-y-4 rounded-lg border border-destructive/40 bg-card p-5">
        <header className="space-y-1">
          <h2 className="text-base font-semibold text-destructive">Danger zone</h2>
          <p className="text-sm text-muted-foreground">
            Deleting a project permanently removes its datasets, prompts, and
            runs. This cannot be undone.
          </p>
        </header>

        {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}

        {!confirming ? (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirming(true)
                setDeleteError(null)
              }}
            >
              <Trash2 />
              Delete project
            </Button>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/40 p-4 space-y-3">
            <p className="text-sm">
              Permanently delete <strong>{project.name}</strong>?
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={onDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Yes, delete'}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
