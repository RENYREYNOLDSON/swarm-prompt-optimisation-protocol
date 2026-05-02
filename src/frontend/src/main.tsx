import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'

const PUBLISHABLE_KEY = import.meta.env.NEXT_PUBLIC_SWARM_AUTH_CLERK_PUBLISHABLE_KEY

const root = createRoot(document.getElementById('root')!)

if (!PUBLISHABLE_KEY) {
  root.render(
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '4rem auto', padding: '0 1.25rem' }}>
      <h1>Configuration needed</h1>
      <p>
        <code>NEXT_PUBLIC_SWARM_AUTH_CLERK_PUBLISHABLE_KEY</code> is not set.
      </p>
      <p>
        Add it to <code>src/frontend/.env.local</code> for local dev, and to your
        Vercel project's Environment Variables for deployments. Restart the dev
        server after editing <code>.env.local</code>.
      </p>
    </main>,
  )
} else {
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ClerkProvider>
    </StrictMode>,
  )
}
