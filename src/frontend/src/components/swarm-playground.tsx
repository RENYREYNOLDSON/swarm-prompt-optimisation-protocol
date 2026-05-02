import { useEffect, useState } from 'react'
import { Boxes, Maximize2, Minimize2, Square } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SwarmCanvas2D, type SwarmParams } from '@/components/swarm-canvas-2d'
import { SwarmCanvas3D } from '@/components/swarm-canvas-3d'
import { cn } from '@/lib/utils'

const DEFAULT_PARAMS: SwarmParams = {
  agentCount: 48,
  speed: 1.4,
  turnJitter: 0.45,
  trailLength: 30,
  agentSize: 4,
}

export function SwarmPlayground() {
  const [params, setParams] = useState<SwarmParams>(DEFAULT_PARAMS)
  const [fullscreen, setFullscreen] = useState(false)

  const update = <K extends keyof SwarmParams>(key: K, value: SwarmParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }))

  // Esc key exits fullscreen
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  // Lock body scroll while fullscreen
  useEffect(() => {
    if (!fullscreen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [fullscreen])

  const sliders = (
    <>
      <SliderRow
        label="Agent count"
        value={params.agentCount}
        min={4}
        max={200}
        step={1}
        onChange={(v) => update('agentCount', v)}
      />
      <SliderRow
        label="Speed"
        value={params.speed}
        min={0.1}
        max={4}
        step={0.05}
        onChange={(v) => update('speed', v)}
      />
      <SliderRow
        label="Turn jitter"
        value={params.turnJitter}
        min={0.05}
        max={1.5}
        step={0.05}
        onChange={(v) => update('turnJitter', v)}
      />
      <SliderRow
        label="Trail length"
        value={params.trailLength}
        min={2}
        max={120}
        step={1}
        onChange={(v) => update('trailLength', v)}
      />
      <SliderRow
        label="Agent size"
        value={params.agentSize}
        min={1}
        max={12}
        step={0.5}
        onChange={(v) => update('agentSize', v)}
      />
    </>
  )

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex bg-background text-foreground">
        <aside className="w-72 shrink-0 border-r flex flex-col">
          <header className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Run data</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Live agent state and pheromone metrics will appear here during runs.
            </p>
          </header>
          <div className="flex-1 overflow-auto px-4 py-4 space-y-4 text-sm">
            <RunDataPlaceholder />
            <div className="border-t pt-4 space-y-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Visualisation
              </p>
              {sliders}
            </div>
          </div>
        </aside>

        <FullscreenViewer
          params={params}
          onClose={() => setFullscreen(false)}
        />
      </div>
    )
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <Tabs defaultValue="2d" className="space-y-4">
        <TabsList>
          <TabsTrigger value="2d">
            <Square className="size-4" />
            2D
          </TabsTrigger>
          <TabsTrigger value="3d">
            <Boxes className="size-4" />
            3D
          </TabsTrigger>
        </TabsList>
        <TabsContent value="2d">
          <VizCard
            title="2D agent swarm"
            onFullscreen={() => setFullscreen(true)}
          >
            <SwarmCanvas2D params={params} />
          </VizCard>
        </TabsContent>
        <TabsContent value="3d">
          <VizCard
            title="3D agent swarm"
            footer="Drag to orbit · scroll to zoom."
            onFullscreen={() => setFullscreen(true)}
          >
            <SwarmCanvas3D params={params} />
          </VizCard>
        </TabsContent>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Parameters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">{sliders}</CardContent>
      </Card>
    </div>
  )
}

function VizCard({
  title,
  footer,
  onFullscreen,
  children,
}: {
  title: string
  footer?: string
  onFullscreen: () => void
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">{title}</CardTitle>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onFullscreen}
          aria-label="Fullscreen"
          title="Fullscreen"
        >
          <Maximize2 className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <div className="aspect-[16/10] w-full overflow-hidden rounded-md border bg-card">
          {children}
        </div>
        {footer && (
          <p className="mt-2 text-xs text-muted-foreground">{footer}</p>
        )}
      </CardContent>
    </Card>
  )
}

function FullscreenViewer({
  params,
  onClose,
}: {
  params: SwarmParams
  onClose: () => void
}) {
  const [tab, setTab] = useState<'2d' | '3d'>('2d')
  return (
    <main className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as '2d' | '3d')}>
          <TabsList>
            <TabsTrigger value="2d">
              <Square className="size-4" />
              2D
            </TabsTrigger>
            <TabsTrigger value="3d">
              <Boxes className="size-4" />
              3D
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onClose}
          aria-label="Exit fullscreen"
          title="Exit fullscreen (Esc)"
        >
          <Minimize2 className="size-4" />
        </Button>
      </header>
      <div className="relative flex-1 bg-card">
        <div className={cn('absolute inset-0', tab !== '2d' && 'hidden')}>
          <SwarmCanvas2D params={params} />
        </div>
        <div className={cn('absolute inset-0', tab !== '3d' && 'hidden')}>
          <SwarmCanvas3D params={params} />
        </div>
      </div>
    </main>
  )
}

function RunDataPlaceholder() {
  return (
    <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
      No active run. Start one to stream live agent positions, pheromone
      intensities and convergence metrics.
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">{label}</label>
        <span className="text-xs font-mono text-muted-foreground">
          {value.toFixed(step < 1 ? 2 : 0)}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
      />
    </div>
  )
}
