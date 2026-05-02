import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'

export type SwarmType = 'aco' | 'pso' | 'abc' | 'firefly'
export type RunModel =
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5'
export type ThoughtLevel = 'minimal' | 'standard' | 'deep' | 'extreme'

export type RunConfig = {
  swarm_type: SwarmType
  model: RunModel
  num_agents: number
  thought_level: ThoughtLevel
  randomness: number
  pheromone_strength: number
}

const DEFAULT_CONFIG: RunConfig = {
  swarm_type: 'aco',
  model: 'claude-sonnet-4-6',
  num_agents: 8,
  thought_level: 'standard',
  randomness: 0.3,
  pheromone_strength: 0.6,
}

const SWARM_LABEL: Record<SwarmType, string> = {
  aco: 'Ant Colony Optimisation',
  pso: 'Particle Swarm Optimisation',
  abc: 'Artificial Bee Colony',
  firefly: 'Firefly Algorithm',
}

const MODEL_LABEL: Record<RunModel, string> = {
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
}

const THOUGHT_LABEL: Record<ThoughtLevel, string> = {
  minimal: 'Minimal',
  standard: 'Standard',
  deep: 'Deep',
  extreme: 'Extreme',
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (config: RunConfig) => void
}

export function NewRunDialog({ open, onOpenChange, onCreated }: Props) {
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null)
  const dialogRef = useCallback((el: HTMLDialogElement | null) => {
    setDialogEl(el)
  }, [])
  const [config, setConfig] = useState<RunConfig>(DEFAULT_CONFIG)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!dialogEl) return
    if (open && !dialogEl.open) dialogEl.showModal()
    if (!open && dialogEl.open) dialogEl.close()
  }, [open, dialogEl])

  useEffect(() => {
    if (!open) {
      setConfig(DEFAULT_CONFIG)
      setSubmitting(false)
    }
  }, [open])

  function patch<K extends keyof RunConfig>(key: K, value: RunConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }))
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    onCreated(config)
    onOpenChange(false)
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onOpenChange(false)}
      onClick={(e) => {
        if (e.target === dialogEl) onOpenChange(false)
      }}
      className="fixed inset-0 m-auto h-fit max-h-[90vh] w-fit max-w-[90vw] rounded-lg border bg-card text-card-foreground p-0 shadow-lg backdrop:bg-foreground/40"
    >
      <form onSubmit={onSubmit} className="w-[32rem] max-w-[90vw] p-6 space-y-5">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold">New run</h2>
          <p className="text-sm text-muted-foreground">
            Configure the swarm before kicking it off.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="nr-swarm">Swarm type</Label>
            <Select
              value={config.swarm_type}
              onValueChange={(v) => patch('swarm_type', v as SwarmType)}
            >
              <SelectTrigger id="nr-swarm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent container={dialogEl}>
                {(Object.keys(SWARM_LABEL) as SwarmType[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {SWARM_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="nr-model">AI model</Label>
            <Select
              value={config.model}
              onValueChange={(v) => patch('model', v as RunModel)}
            >
              <SelectTrigger id="nr-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent container={dialogEl}>
                {(Object.keys(MODEL_LABEL) as RunModel[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {MODEL_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="nr-agents">Number of agents</Label>
              <span className="text-xs font-medium tabular-nums text-muted-foreground">
                {config.num_agents}
              </span>
            </div>
            <Slider
              id="nr-agents"
              min={2}
              max={64}
              step={1}
              value={[config.num_agents]}
              onValueChange={(v) => patch('num_agents', v[0] ?? 8)}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="nr-thought">Thought level</Label>
            <Select
              value={config.thought_level}
              onValueChange={(v) => patch('thought_level', v as ThoughtLevel)}
            >
              <SelectTrigger id="nr-thought">
                <SelectValue />
              </SelectTrigger>
              <SelectContent container={dialogEl}>
                {(Object.keys(THOUGHT_LABEL) as ThoughtLevel[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {THOUGHT_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="nr-randomness">Randomness</Label>
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {config.randomness.toFixed(2)}
            </span>
          </div>
          <Slider
            id="nr-randomness"
            min={0}
            max={1}
            step={0.01}
            value={[config.randomness]}
            onValueChange={(v) => patch('randomness', v[0] ?? 0.3)}
          />
          <p className="text-xs text-muted-foreground">
            How often agents explore vs. exploit known-good paths.
          </p>
        </div>

        <div className="grid gap-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="nr-pheromone">Pheromone strength</Label>
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {config.pheromone_strength.toFixed(2)}
            </span>
          </div>
          <Slider
            id="nr-pheromone"
            min={0}
            max={1}
            step={0.01}
            value={[config.pheromone_strength]}
            onValueChange={(v) => patch('pheromone_strength', v[0] ?? 0.6)}
          />
          <p className="text-xs text-muted-foreground">
            How strongly successful trails reinforce future agent decisions.
          </p>
        </div>

        <footer className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            Start run
          </Button>
        </footer>
      </form>
    </dialog>
  )
}
