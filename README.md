# swarm-prompt-optimisation-protocol

SPOP (Swarm Prompt Optimisation Protocol) — generate accurate prompts from context+output using swarm intelligence applied to LLMs.

## Layout

```
api/index.py            # Vercel Python entrypoint (re-exports FastAPI app)
src/backend/            # FastAPI application
src/frontend/           # React + Vite + TypeScript app
vercel.json             # Vercel deployment config
requirements.txt        # Root requirements (used by Vercel @vercel/python)
```

## Local development

Install dev deps (includes uvicorn; not shipped to Vercel):

```
.venv/bin/pip install -r src/backend/requirements-dev.txt
```

One-shot: build the frontend and run the backend (serves the built UI + API on :8000):

```
cd src/frontend && npm run build && cd ../.. && .venv/bin/uvicorn app.main:app --app-dir src/backend --host 0.0.0.0 --port 8000
```

Or run them separately during dev:

Backend (FastAPI on :8000):

```
.venv/bin/uvicorn app.main:app --reload --app-dir src/backend
```

Frontend (Vite on :5173, proxies `/api` to :8000):

```
cd src/frontend
npm run dev
```

## Deploy to Vercel

```
npm i -g vercel
vercel
```

The `vercel.json` builds the frontend into `src/frontend/dist`, deploys `api/index.py` as a Python serverless function, and rewrites `/api/*` to it.
