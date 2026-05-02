/* eslint-disable react-refresh/only-export-components */
import { useCallback, useState } from 'react'
import { Outlet, useOutletContext } from 'react-router-dom'

import { NewProjectDialog } from '@/components/new-project-dialog'
import { ProjectsSidebar } from '@/components/projects-sidebar'

export type AppShellContext = {
  refreshProjects: () => void
}

export function AppShell() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshProjects = useCallback(() => setRefreshKey((k) => k + 1), [])

  const ctx: AppShellContext = { refreshProjects }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <ProjectsSidebar
        onNewProject={() => setDialogOpen(true)}
        refreshKey={refreshKey}
      />
      <main className="flex-1 overflow-auto">
        <Outlet context={ctx} />
      </main>
      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={refreshProjects}
      />
    </div>
  )
}

export function useAppShell(): AppShellContext {
  return useOutletContext<AppShellContext>()
}
