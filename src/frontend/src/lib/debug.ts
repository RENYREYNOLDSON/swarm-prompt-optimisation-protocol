// Lightweight debug logger gated on `localStorage.getItem('spop:debug') === '1'`.
// In a browser console, run `localStorage.setItem('spop:debug', '1')` and
// reload to enable. Use namespaces to filter (`?spop:debug=swarm` or set
// `localStorage.spop:debug:ns` to a comma-separated list of namespaces;
// '*' or unset = all).

function _enabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem('spop:debug') === '1'
  } catch {
    return false
  }
}

function _allowedNamespaces(): Set<string> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem('spop:debug:ns')
    if (!raw || raw === '*') return null
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  } catch {
    return null
  }
}

export function debugLog(ns: string, ...args: unknown[]): void {
  if (!_enabled()) return
  const allowed = _allowedNamespaces()
  if (allowed && !allowed.has(ns)) return
  const ts = new Date().toISOString().slice(11, 23)

  console.debug(`%c[${ts}] ${ns}`, 'color:#888;font-weight:600', ...args)
}

export function debugWarn(ns: string, ...args: unknown[]): void {
  if (!_enabled()) return
  const allowed = _allowedNamespaces()
  if (allowed && !allowed.has(ns)) return
  const ts = new Date().toISOString().slice(11, 23)

  console.warn(`[${ts}] ${ns}`, ...args)
}

export function debugError(ns: string, ...args: unknown[]): void {
  // Errors always log regardless of the gate — they're rare and load-bearing.
  const ts = new Date().toISOString().slice(11, 23)

  console.error(`[${ts}] ${ns}`, ...args)
}
