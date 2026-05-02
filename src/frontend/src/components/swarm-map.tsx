import { useMemo } from 'react'

import type { SwarmAttempt } from '@/lib/swarm'
import { cn } from '@/lib/utils'

type Props = {
  attempts: SwarmAttempt[]
  layout: Map<string, { x: number; y: number }>
  bestAttemptId: string | null
  selectedId?: string | null
  onSelect?: (attemptId: string) => void
}

const PAD = 24            // px padding around the [-1,1] viewport
const R_MIN = 3
const R_MAX = 14

function colourForScore(s: number | null): string {
  if (s === null) return 'hsl(220 8% 70%)'
  // red → yellow → green
  return `hsl(${Math.round(120 * Math.max(0, Math.min(1, s)))} 70% 50%)`
}

export function SwarmMap({
  attempts,
  layout,
  bestAttemptId,
  selectedId,
  onSelect,
}: Props) {
  // Normalise pheromones for radius scaling.
  const pheroP99 = useMemo(() => {
    const vals = attempts
      .map((a) => a.pheromone)
      .filter((v) => v > 0)
      .sort((a, b) => a - b)
    if (vals.length === 0) return 1
    return vals[Math.floor(vals.length * 0.99)] || 1
  }, [attempts])

  const placed = useMemo(() => {
    return attempts
      .map((a) => {
        const xy = layout.get(a.id) ?? (a.x !== null && a.y !== null ? { x: a.x, y: a.y } : null)
        if (!xy) return null
        return { attempt: a, xy }
      })
      .filter((v): v is { attempt: SwarmAttempt; xy: { x: number; y: number } } => v !== null)
  }, [attempts, layout])

  const placedIds = useMemo(
    () => new Set(placed.map((p) => p.attempt.id)),
    [placed],
  )

  // viewBox uses a normalised [-1, 1] coordinate system padded into a
  // 1000×1000 canvas so SVG stroke widths feel natural.
  const W = 1000
  const H = 1000
  const project = (x: number, y: number) => ({
    cx: PAD + ((x + 1) / 2) * (W - 2 * PAD),
    // flip y so positive is up
    cy: PAD + ((1 - (y + 1) / 2)) * (H - 2 * PAD),
  })

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-full w-full select-none"
      role="img"
      aria-label="Swarm prompt map"
    >
      {/* background grid */}
      <defs>
        <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
          <path
            d="M 50 0 L 0 0 0 50"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.06"
            strokeWidth="1"
          />
        </pattern>
        <radialGradient id="bestHalo">
          <stop offset="0%" stopColor="hsl(50 100% 60%)" stopOpacity="0.6" />
          <stop offset="100%" stopColor="hsl(50 100% 60%)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill="url(#grid)" />

      {/* parent → child trails (drawn behind dots) */}
      <g>
        {placed.map(({ attempt, xy }) => {
          if (!attempt.parent_attempt_id) return null
          if (!placedIds.has(attempt.parent_attempt_id)) return null
          const parentXy =
            layout.get(attempt.parent_attempt_id) ??
            (() => {
              const p = attempts.find((a) => a.id === attempt.parent_attempt_id)
              return p && p.x !== null && p.y !== null ? { x: p.x, y: p.y } : null
            })()
          if (!parentXy) return null
          const a = project(xy.x, xy.y)
          const b = project(parentXy.x, parentXy.y)
          const opacity = Math.max(0.05, attempt.score ?? 0)
          return (
            <line
              key={`trail-${attempt.id}`}
              x1={b.cx}
              y1={b.cy}
              x2={a.cx}
              y2={a.cy}
              stroke="currentColor"
              strokeOpacity={opacity * 0.8}
              strokeWidth={1.2}
              className="text-foreground"
            />
          )
        })}
      </g>

      {/* halo behind the best attempt */}
      {bestAttemptId &&
        placed
          .filter((p) => p.attempt.id === bestAttemptId)
          .map(({ xy }) => {
            const { cx, cy } = project(xy.x, xy.y)
            return (
              <circle
                key="best-halo"
                cx={cx}
                cy={cy}
                r={R_MAX * 2.5}
                fill="url(#bestHalo)"
              />
            )
          })}

      {/* dots */}
      <g>
        {placed.map(({ attempt, xy }) => {
          const { cx, cy } = project(xy.x, xy.y)
          const t = pheroP99 > 0 ? Math.min(1, attempt.pheromone / pheroP99) : 0
          const r = R_MIN + (R_MAX - R_MIN) * t
          const isBest = attempt.id === bestAttemptId
          const isSelected = attempt.id === selectedId
          const isPending = attempt.status !== 'done' && attempt.status !== 'failed'
          return (
            <g key={attempt.id}>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={colourForScore(attempt.score)}
                fillOpacity={0.4 + 0.6 * t}
                stroke={isBest ? 'hsl(50 100% 60%)' : isSelected ? 'currentColor' : 'none'}
                strokeWidth={isBest ? 2 : isSelected ? 1.5 : 0}
                className={cn(
                  'transition-[cx,cy,r,fill] duration-700 ease-out cursor-pointer',
                  isPending && 'animate-pulse',
                )}
                onClick={() => onSelect?.(attempt.id)}
              />
              <title>
                {`turn ${attempt.turn} · agent ${attempt.agent_idx}` +
                  (attempt.score !== null ? ` · score ${attempt.score.toFixed(3)}` : '') +
                  ` · pheromone ${attempt.pheromone.toFixed(3)}` +
                  (attempt.error ? `\nerror: ${attempt.error}` : '')}
              </title>
            </g>
          )
        })}
      </g>

      {placed.length === 0 && (
        <g>
          <text
            x={W / 2}
            y={H / 2 - 8}
            textAnchor="middle"
            className="fill-muted-foreground"
            fontSize="20"
          >
            no attempts yet
          </text>
          <text
            x={W / 2}
            y={H / 2 + 18}
            textAnchor="middle"
            className="fill-muted-foreground"
            fontSize="14"
          >
            press start to release the swarm
          </text>
        </g>
      )}
    </svg>
  )
}
