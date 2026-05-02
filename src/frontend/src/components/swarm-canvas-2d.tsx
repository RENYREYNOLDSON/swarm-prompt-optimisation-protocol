import { useEffect, useRef } from 'react'

export type SwarmParams = {
  agentCount: number
  speed: number
  turnJitter: number
  trailLength: number
  agentSize: number
}

type Agent = {
  x: number
  y: number
  heading: number
  speed: number
}

export function SwarmCanvas2D({ params }: { params: SwarmParams }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useRef(params)
  paramsRef.current = params

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    let width = 0
    let height = 0
    let raf = 0

    const isDark = () => document.documentElement.classList.contains('dark')

    const bgColor = () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--card')
        .trim() || (isDark() ? '#1c1c20' : '#fafafa')

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = bgColor()
      ctx.fillRect(0, 0, width, height)
    }

    const spawnAgent = (): Agent => ({
      x: Math.random() * Math.max(width, 1),
      y: Math.random() * Math.max(height, 1),
      heading: Math.random() * Math.PI * 2,
      speed: 0.5 + Math.random() * 1.0,
    })

    let agents: Agent[] = []

    const ensureAgentCount = (target: number) => {
      while (agents.length < target) agents.push(spawnAgent())
      if (agents.length > target) agents.length = target
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const tick = () => {
      const p = paramsRef.current
      ensureAgentCount(p.agentCount)

      // Pheromone dissipation — alpha derived from trailLength so longer trail = lower fade
      const fadeAlpha = Math.min(1, 1 / Math.max(p.trailLength, 1))
      ctx.globalAlpha = fadeAlpha
      ctx.fillStyle = bgColor()
      ctx.fillRect(0, 0, width, height)
      ctx.globalAlpha = 1

      const dark = isDark()
      ctx.fillStyle = dark
        ? 'rgba(255, 255, 255, 0.9)'
        : 'rgba(30, 30, 40, 0.7)'

      for (const a of agents) {
        a.heading += (Math.random() - 0.5) * p.turnJitter
        a.x += Math.cos(a.heading) * p.speed * a.speed
        a.y += Math.sin(a.heading) * p.speed * a.speed
        if (a.x < 0) a.x += width
        if (a.x > width) a.x -= width
        if (a.y < 0) a.y += height
        if (a.y > height) a.y -= height
        ctx.fillRect(
          a.x - p.agentSize / 2,
          a.y - p.agentSize / 2,
          p.agentSize,
          p.agentSize,
        )
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="size-full block rounded-md"
    />
  )
}
