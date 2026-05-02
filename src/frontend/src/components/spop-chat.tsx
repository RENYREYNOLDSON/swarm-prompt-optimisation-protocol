import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Loader2, Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/markdown'
import { streamChat, type ChatMessage } from '@/lib/generate'
import {
  useProjectState,
  type SpopMessage,
} from '@/lib/project-state'
import { cn } from '@/lib/utils'

let _idCounter = 0
function newId(prefix: string): string {
  _idCounter += 1
  return `${prefix}_${Date.now()}_${_idCounter}`
}

function SpopAvatar({ className }: { className?: string }) {
  return (
    <img
      src="/logo.svg"
      alt="SPOP"
      className={cn('size-5 shrink-0 dark:invert', className)}
    />
  )
}

export function SpopChat() {
  const { getToken } = useAuth()
  const { project, spopMessages, appendChat, patchChat, generating } =
    useProjectState()

  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [spopMessages])

  async function send() {
    const text = input.trim()
    if (!text || sending || !project) return
    setSending(true)

    const userMsg: SpopMessage = {
      id: newId('user'),
      role: 'user',
      content: text,
    }
    appendChat(userMsg)
    setInput('')

    const assistantId = newId('asst')
    appendChat({
      id: assistantId,
      role: 'assistant',
      content: '',
      pending: true,
    })

    const history: ChatMessage[] = spopMessages.flatMap((m) =>
      m.role === 'user' || m.role === 'assistant'
        ? [{ role: m.role, content: m.content }]
        : [],
    )
    history.push({ role: 'user', content: text })

    try {
      let acc = ''
      for await (const chunk of streamChat(project.id, history, getToken)) {
        acc += chunk
        patchChat(assistantId, { content: acc })
      }
      patchChat(assistantId, { pending: false })
    } catch (e) {
      patchChat(assistantId, {
        content: `[error: ${e instanceof Error ? e.message : 'failed'}]`,
        pending: false,
      })
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <section className="rounded-lg border bg-card text-card-foreground">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <SpopAvatar className="size-4" />
          <h2 className="text-xs font-semibold">SPOP</h2>
          {generating && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Setting up project…
            </span>
          )}
        </div>
      </header>

      <div
        ref={scrollerRef}
        className="h-40 overflow-auto px-3 py-2 space-y-2"
      >
        {spopMessages.map((m) => (
          <ChatBubble key={m.id} message={m} />
        ))}
      </div>

      <div className="border-t p-2">
        <div className="flex gap-2">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask SPOP about the datasets, schema, or prompt…"
            className="flex-1 resize-none rounded-md border bg-background px-2.5 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          />
          <Button
            onClick={send}
            disabled={sending || !input.trim()}
            size="icon"
            className="size-8"
          >
            {sending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
    </section>
  )
}

function ChatBubble({ message: m }: { message: SpopMessage }) {
  const isUser = m.role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-2.5 py-1.5 text-xs whitespace-pre-wrap text-primary-foreground">
          {m.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2">
      <SpopAvatar className="mt-0.5 size-4" />
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs',
          m.role === 'assistant'
            ? 'bg-secondary text-secondary-foreground'
            : 'bg-muted text-foreground',
        )}
      >
        <Markdown>{m.content}</Markdown>
        {m.pending && (
          <span className="inline-block size-1.5 ml-1 rounded-full bg-current animate-pulse align-middle" />
        )}
      </div>
    </div>
  )
}

