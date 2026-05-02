import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { RunArtifact } from '@/lib/project-state'
import { cn } from '@/lib/utils'

type DatasetDetail = {
  id: string
  idx: number
  title: string
  content: string
  token_count: number | null
  created_at: string
}

type Props = {
  projectId: string
  idx: number | null
  run?: RunArtifact
  onClose: () => void
}

export function DatasetDetailDialog({ projectId, idx, run, onClose }: Props) {
  const { getToken } = useAuth()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [detail, setDetail] = useState<DatasetDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'document' | 'output'>('document')

  // Sync open state with the idx prop
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (idx !== null && !el.open) el.showModal()
    if (idx === null && el.open) el.close()
  }, [idx])

  // Fetch full content when opened
  useEffect(() => {
    if (idx === null) {
      setDetail(null)
      setError(null)
      setTab('document')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(
          `/api/projects/${projectId}/datasets/${idx}`,
          {
            headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
          },
        )
        if (!res.ok) {
          let detailMsg = res.statusText
          try {
            const body = await res.json()
            if (body?.detail) detailMsg = body.detail
          } catch {
            /* ignore */
          }
          throw new Error(detailMsg)
        }
        const body: DatasetDetail = await res.json()
        if (!cancelled) setDetail(body)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken, idx, projectId])

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
      className="fixed inset-0 m-auto h-fit max-h-[90vh] w-fit max-w-[90vw] rounded-lg border bg-card text-card-foreground p-0 shadow-lg backdrop:bg-foreground/40"
    >
      <div className="flex h-[80vh] w-[min(900px,90vw)] flex-col">
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Dataset {idx}/10
            </p>
            <h2 className="truncate text-base font-semibold">
              {detail?.title || (loading ? 'Loading…' : '')}
            </h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <nav className="flex gap-1 border-b px-4">
          <TabButton active={tab === 'document'} onClick={() => setTab('document')}>
            Document
            {detail && (
              <span className="ml-1 text-[10px] text-muted-foreground/70">
                {detail.content.length.toLocaleString()} chars
              </span>
            )}
          </TabButton>
          <TabButton active={tab === 'output'} onClick={() => setTab('output')}>
            Structured output
            {run?.status === 'pending' && (
              <Loader2 className="ml-1 size-3 animate-spin text-muted-foreground" />
            )}
          </TabButton>
        </nav>

        <div className="flex-1 overflow-auto px-4 py-4">
          {error && <p className="text-sm text-destructive">{error}</p>}

          {tab === 'document' && (
            <>
              {loading && (
                <p className="text-sm text-muted-foreground">Loading document…</p>
              )}
              {detail && (
                <pre className="text-xs leading-relaxed whitespace-pre-wrap font-sans">
                  {detail.content}
                </pre>
              )}
            </>
          )}

          {tab === 'output' && (
            <RunPanel run={run} />
          )}
        </div>
      </div>
    </dialog>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
        active
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function RunPanel({ run }: { run?: RunArtifact }) {
  if (!run || run.status === 'idle') {
    return (
      <p className="text-sm text-muted-foreground">
        No run yet. The structured output will appear here once the prompt
        executes against this dataset.
      </p>
    )
  }
  if (run.status === 'pending') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Running prompt against this dataset…
      </div>
    )
  }
  if (run.status === 'failed') {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
        <p className="text-sm font-semibold text-destructive">Extraction failed</p>
        <p className="mt-1 text-sm text-destructive/80">{run.error}</p>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {run.model && <span>{run.model}</span>}
        {run.tokens_in !== undefined && (
          <span>{run.tokens_in.toLocaleString()} input tok</span>
        )}
        {run.tokens_out !== undefined && (
          <span>{run.tokens_out.toLocaleString()} output tok</span>
        )}
        {run.latency_ms !== undefined && (
          <span>{(run.latency_ms / 1000).toFixed(1)}s</span>
        )}
      </div>
      <pre className="overflow-auto rounded-md border bg-muted/30 p-3 text-[11px] font-mono leading-relaxed">
        {JSON.stringify(run.structured_output, null, 2)}
      </pre>
    </div>
  )
}
