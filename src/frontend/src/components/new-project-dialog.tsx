import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { useApi } from '@/lib/api'

const DIFFICULTY_LABELS: Record<number, string> = {
  1: 'Trivial',
  2: 'Easy',
  3: 'Easy',
  4: 'Moderate',
  5: 'Moderate',
  6: 'Challenging',
  7: 'Challenging',
  8: 'Hard',
  9: 'Hard',
  10: 'Brutal',
}

const DIFFICULTY_HINT: Record<number, string> = {
  1: 'Short, plain documents and a 10-field flat schema.',
  2: 'Short, mostly flat documents with a small schema.',
  3: 'Modest length, light structure, mostly flat schema.',
  4: 'Medium-length documents with some sections and a 10–12 field schema.',
  5: 'Realistic length, some nesting, moderate ambiguity.',
  6: 'Longer documents, multiple nested sections, 12+ field schema.',
  7: 'Dense, varied formats, multi-level nesting in the schema.',
  8: 'Long, detail-heavy documents and a deeply structured schema.',
  9: 'Adversarial edge cases, conflicting signals, deep nesting.',
  10: 'Maximum length and ambiguity. Deep nesting, tight constraints.',
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

export function NewProjectDialog({ open, onOpenChange, onCreated }: Props) {
  const api = useApi()
  const navigate = useNavigate()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [difficulty, setDifficulty] = useState(5)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  useEffect(() => {
    if (!open) {
      setName('')
      setDomain('')
      setDifficulty(5)
      setError(null)
      setSubmitting(false)
    }
  }, [open])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const project = await api.createProject({
        name: name.trim(),
        domain: domain.trim(),
        difficulty,
      })
      onCreated()
      onOpenChange(false)
      navigate(`/app/projects/${project.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project')
      setSubmitting(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onOpenChange(false)}
      onClick={(e) => {
        if (e.target === dialogRef.current) onOpenChange(false)
      }}
      className="fixed inset-0 m-auto h-fit max-h-[90vh] w-fit max-w-[90vw] rounded-lg border bg-card text-card-foreground p-0 shadow-lg backdrop:bg-foreground/40"
    >
      <form onSubmit={onSubmit} className="w-[28rem] max-w-[90vw] p-6 space-y-5">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold">New project</h2>
          <p className="text-sm text-muted-foreground">
            Give your project a name and the domain it focuses on.
          </p>
        </header>

        <div className="grid gap-2">
          <Label htmlFor="np-name">Name</Label>
          <Input
            id="np-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
            autoFocus
            placeholder="Claims triage"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="np-domain">Domain</Label>
          <Textarea
            id="np-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            required
            maxLength={500}
            rows={3}
            placeholder="Medical insurance claims adjudication for US payers."
          />
          <p className="text-xs text-muted-foreground">
            We'll generate sample datasets and a structured prompt scoped to this domain.
          </p>
        </div>

        <div className="grid gap-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="np-difficulty">Difficulty</Label>
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {difficulty} · {DIFFICULTY_LABELS[difficulty]}
            </span>
          </div>
          <Slider
            id="np-difficulty"
            min={1}
            max={10}
            step={1}
            value={[difficulty]}
            onValueChange={(v) => setDifficulty(v[0] ?? 5)}
          />
          <p className="text-xs text-muted-foreground">{DIFFICULTY_HINT[difficulty]}</p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <footer className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !name.trim() || !domain.trim()}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </footer>
      </form>
    </dialog>
  )
}
