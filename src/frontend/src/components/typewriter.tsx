import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

type TypewriterProps = {
  text: string
  cps?: number // chars per second
  startDelay?: number // ms before typing starts (after activation)
  whileInView?: boolean // wait until element is scrolled into view
  caret?: boolean
  className?: string
}

export function Typewriter({
  text,
  cps = 55,
  startDelay = 0,
  whileInView = false,
  caret = true,
  className,
}: TypewriterProps) {
  const [n, setN] = useState(0)
  const [active, setActive] = useState(!whileInView)
  const ref = useRef<HTMLSpanElement>(null)

  // Trigger when scrolled into view
  useEffect(() => {
    if (!whileInView || active) return
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setActive(true)
          obs.disconnect()
        }
      },
      { threshold: 0.25 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [whileInView, active])

  // Type characters once active
  useEffect(() => {
    if (!active) return
    const tickMs = 1000 / cps
    let timer: number | null = null
    let cancelled = false
    let i = 0

    const startAt = performance.now() + startDelay

    const step = () => {
      if (cancelled) return
      const now = performance.now()
      if (now < startAt) {
        timer = window.setTimeout(step, startAt - now)
        return
      }
      i = Math.min(text.length, i + 1)
      setN(i)
      if (i < text.length) timer = window.setTimeout(step, tickMs)
    }
    step()

    return () => {
      cancelled = true
      if (timer != null) clearTimeout(timer)
    }
  }, [active, text, cps, startDelay])

  const done = n >= text.length

  return (
    <span
      ref={ref}
      className={cn('relative inline-block align-top', className)}
    >
      {/* Ghost copy preserves wrapped layout so the surrounding flow doesn't reflow as we type */}
      <span aria-hidden="true" className="invisible">
        {text}
      </span>
      <span className="absolute inset-0">
        {text.slice(0, n)}
        {caret && !done && (
          <span className="ml-0.5 inline-block w-[2px] h-[0.95em] bg-current align-[-0.1em] animate-pulse" />
        )}
      </span>
    </span>
  )
}
