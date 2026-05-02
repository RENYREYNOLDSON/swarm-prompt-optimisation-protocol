import { useEffect, useRef } from 'react'

type FlashKind = 'green' | 'red'

type Agent = {
  x: number
  y: number
  heading: number
  speed: number
  flash: { kind: FlashKind; ttl: number; max: number } | null
}

const AGENT_COUNT = 64
const AGENT_SIZE = 3
const TURN_JITTER = 0.45
const FADE_ALPHA = 0.12
const FLASH_DURATION = 28
const GREEN_FLASH_CHANCE = 1 / 1750
const RED_FLASH_CHANCE = 1 / 9000

export function SwarmBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0
    let height = 0
    let raf = 0

    const isDark = () => document.documentElement.classList.contains('dark')

    const bgColor = () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--background')
        .trim() || (isDark() ? '#141418' : '#ffffff')

    const resize = () => {
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = bgColor()
      ctx.fillRect(0, 0, width, height)
    }

    const spawn = (): Agent => ({
      x: Math.random() * (width || window.innerWidth),
      y: Math.random() * (height || window.innerHeight),
      heading: Math.random() * Math.PI * 2,
      speed: 0.35 + Math.random() * 0.7,
      flash: null,
    })

    const agents: Agent[] = Array.from({ length: AGENT_COUNT }, spawn)

    resize()
    window.addEventListener('resize', resize)

    const tick = () => {
      const dark = isDark()

      // Pheromone dissipation — fade towards the actual page background colour
      ctx.globalAlpha = FADE_ALPHA
      ctx.fillStyle = bgColor()
      ctx.fillRect(0, 0, width, height)
      ctx.globalAlpha = 1

      const baseColor = dark
        ? 'rgba(255, 255, 255, 0.9)'
        : 'rgba(30, 30, 40, 0.55)'

      for (let i = 0; i < agents.length; i++) {
        const a = agents[i]

        // Wander
        a.heading += (Math.random() - 0.5) * TURN_JITTER
        a.x += Math.cos(a.heading) * a.speed
        a.y += Math.sin(a.heading) * a.speed
        if (a.x < 0) a.x += width
        if (a.x > width) a.x -= width
        if (a.y < 0) a.y += height
        if (a.y > height) a.y -= height

        // Roll for new flash if not already flashing
        if (!a.flash) {
          const r = Math.random()
          if (r < RED_FLASH_CHANCE) {
            a.flash = { kind: 'red', ttl: FLASH_DURATION, max: FLASH_DURATION }
          } else if (r < RED_FLASH_CHANCE + GREEN_FLASH_CHANCE) {
            a.flash = { kind: 'green', ttl: FLASH_DURATION, max: FLASH_DURATION }
          }
        }

        if (a.flash) {
          const t = 1 - a.flash.ttl / a.flash.max // 0 → 1
          const alpha = 1 - t
          ctx.fillStyle =
            a.flash.kind === 'green'
              ? `rgba(80, 220, 110, ${alpha})`
              : `rgba(255, 70, 70, ${alpha})`
          ctx.fillRect(
            a.x - AGENT_SIZE / 2,
            a.y - AGENT_SIZE / 2,
            AGENT_SIZE,
            AGENT_SIZE,
          )
          a.flash.ttl -= 1
          if (a.flash.ttl <= 0) {
            agents[i] = spawn()
          }
        } else {
          ctx.fillStyle = baseColor
          ctx.fillRect(
            a.x - AGENT_SIZE / 2,
            a.y - AGENT_SIZE / 2,
            AGENT_SIZE,
            AGENT_SIZE,
          )
        }
      }

      raf = requestAnimationFrame(tick)
    }

    if (reduced) {
      tick()
      cancelAnimationFrame(raf)
    } else {
      raf = requestAnimationFrame(tick)
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 size-full"
    />
  )
}
