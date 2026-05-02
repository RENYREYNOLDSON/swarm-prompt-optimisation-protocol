import { useState } from 'react'
import './App.css'

type OptimiseResponse = { prompt: string }

function App() {
  const [context, setContext] = useState('')
  const [output, setOutput] = useState('')
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setPrompt('')
    try {
      const res = await fetch('/api/optimise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, output }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: OptimiseResponse = await res.json()
      setPrompt(data.prompt)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="container">
      <h1>SPOP</h1>
      <p className="subtitle">Swarm Prompt Optimisation Protocol</p>

      <form onSubmit={onSubmit} className="form">
        <label>
          Context
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={5}
            required
          />
        </label>
        <label>
          Desired output
          <textarea
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            rows={5}
            required
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? 'Optimising…' : 'Generate prompt'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {prompt && (
        <section className="result">
          <h2>Generated prompt</h2>
          <pre>{prompt}</pre>
        </section>
      )}
    </main>
  )
}

export default App
