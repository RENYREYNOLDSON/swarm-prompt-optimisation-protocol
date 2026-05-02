import { useAuth } from '@clerk/clerk-react'
import { useCallback, useMemo } from 'react'

export type Project = {
  id: string
  name: string
  domain: string
  difficulty: number
  status: 'pending' | 'generating' | 'ready' | 'failed'
  created_at: string
  updated_at: string
}

export type ProjectCreate = {
  name: string
  domain: string
  difficulty: number
}

export type ProjectUpdate = {
  name?: string
  domain?: string
}

class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function useApi() {
  const { getToken } = useAuth()

  const request = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> => {
      const token = await getToken()
      const headers = new Headers(init?.headers)
      headers.set('content-type', 'application/json')
      if (token) headers.set('authorization', `Bearer ${token}`)

      const res = await fetch(path, { ...init, headers })
      if (!res.ok) {
        let detail = res.statusText
        try {
          const body = await res.json()
          if (body?.detail) detail = body.detail
        } catch {
          /* ignore */
        }
        throw new ApiError(res.status, detail)
      }
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    },
    [getToken],
  )

  return useMemo(
    () => ({
      listProjects: () => request<Project[]>('/api/projects'),
      getProject: (id: string) => request<Project>(`/api/projects/${id}`),
      createProject: (body: ProjectCreate) =>
        request<Project>('/api/projects', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      updateProject: (id: string, body: ProjectUpdate) =>
        request<Project>(`/api/projects/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      deleteProject: (id: string) =>
        request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
    }),
    [request],
  )
}

export { ApiError }
