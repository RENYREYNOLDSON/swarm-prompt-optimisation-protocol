import { FolderPlus } from 'lucide-react'

export default function AppHome() {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="max-w-md text-center space-y-3">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
          <FolderPlus className="size-6 text-muted-foreground" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">No project selected</h1>
        <p className="text-sm text-muted-foreground">
          Pick a project from the sidebar, or create a new one to generate sample
          datasets and a structured prompt for your domain.
        </p>
      </div>
    </div>
  )
}
