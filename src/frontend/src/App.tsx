import { Routes, Route, Navigate } from 'react-router-dom'
import { SignedIn, SignedOut } from '@clerk/clerk-react'
import Landing from './Landing'
import AppHome from './AppHome'
import Guide from './Guide'
import ProjectView, { DatasetsTab, PromptTab, PlaygroundTab, SettingsTab } from './ProjectView'
import { AppShell } from '@/components/app-shell'

function RequireAuth({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <Navigate to="/" replace />
      </SignedOut>
    </>
  )
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <>
            <SignedOut>
              <Landing />
            </SignedOut>
            <SignedIn>
              <Navigate to="/app" replace />
            </SignedIn>
          </>
        }
      />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<AppHome />} />
        <Route path="guide" element={<Guide />} />
        <Route path="projects/:id" element={<ProjectView />}>
          <Route index element={<Navigate to="datasets" replace />} />
          <Route path="datasets" element={<DatasetsTab />} />
          <Route path="prompt" element={<PromptTab />} />
          <Route path="playground" element={<PlaygroundTab />} />
          <Route path="settings" element={<SettingsTab />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
