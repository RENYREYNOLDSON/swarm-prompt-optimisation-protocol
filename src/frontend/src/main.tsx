import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from '@/components/theme-provider'

const PUBLISHABLE_KEY = import.meta.env.NEXT_PUBLIC_SWARM_AUTH_CLERK_PUBLISHABLE_KEY

const root = createRoot(document.getElementById('root')!)

if (!PUBLISHABLE_KEY) {
  root.render(
    <ThemeProvider defaultTheme="dark">
      <main className="min-h-svh flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-2xl font-semibold">Configuration needed</h1>
          <p className="text-sm text-muted-foreground">
            <code className="font-mono">NEXT_PUBLIC_SWARM_AUTH_CLERK_PUBLISHABLE_KEY</code>{' '}
            is not set. Add it to <code className="font-mono">.env.local</code>{' '}
            and restart the dev server.
          </p>
        </div>
      </main>
    </ThemeProvider>,
  )
} else {
  root.render(
    <StrictMode>
      <ThemeProvider defaultTheme="dark">
        <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ClerkProvider>
      </ThemeProvider>
    </StrictMode>,
  )
}
