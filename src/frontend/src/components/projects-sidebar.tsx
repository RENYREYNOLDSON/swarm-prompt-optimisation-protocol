import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { UserButton } from '@clerk/clerk-react'
import { Plus, FolderOpen, BookOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { useApi, type Project } from '@/lib/api'
import { cn } from '@/lib/utils'

type Props = {
  onNewProject: () => void
  refreshKey?: number
}

export function ProjectsSidebar({ onNewProject, refreshKey }: Props) {
  const api = useApi()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .listProjects()
      .then((p) => {
        if (!cancelled) setProjects(p)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, refreshKey])

  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-card">
      <div className="flex items-center gap-2 px-4 py-4 border-b">
        <img src="/logo.svg" alt="SPOP" className="size-7 dark:invert" />
        <span className="font-semibold tracking-tight">SPOP</span>
      </div>

      <div className="px-3 py-3">
        <Button onClick={onNewProject} className="w-full justify-start" size="sm">
          <Plus />
          New project
        </Button>
      </div>

      <nav className="px-3 pb-2">
        <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Projects
        </p>
        <div className="space-y-0.5">
          {loading && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
          )}
          {error && (
            <p className="px-2 py-1.5 text-sm text-destructive">{error}</p>
          )}
          {!loading && !error && projects.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              No projects yet
            </p>
          )}
          {projects.map((p) => (
            <NavLink
              key={p.id}
              to={`/app/projects/${p.id}`}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground',
                  isActive && 'bg-accent text-accent-foreground',
                )
              }
            >
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{p.name}</span>
            </NavLink>
          ))}
        </div>

        <div className="mt-3 border-t pt-3">
          <NavLink
            to="/app/guide"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground',
                isActive && 'bg-accent text-accent-foreground',
              )
            }
          >
            <BookOpen className="size-4 shrink-0 text-muted-foreground" />
            <span>Guide</span>
          </NavLink>
        </div>
      </nav>

      <div className="mt-auto flex items-center justify-between border-t px-3 py-2">
        <UserButton afterSignOutUrl="/" />
        <ThemeToggle />
      </div>
    </aside>
  )
}
