"""Generation router.

POST /api/projects/{id}/generate
    Idempotent. If the project already has an active job, attaches to it
    (ensuring the in-process runner is alive) and returns its state.
    Otherwise creates a fresh job and spawns a runner. Returns immediately.

GET  /api/projects/{id}/generation
    Snapshot of the latest job for polling — survives client refresh.

GET  /api/projects/{id}/datasets, /datasets/{idx}, /prompt, /runs
    Read endpoints used by the UI to populate the project view.
"""
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg import Connection
from pydantic import BaseModel

from app.auth import CurrentUser
from app.db import connection, db_conn
from app.services.generation_runner import (
    advance,
    advance_all_in_flight,
    get_or_create_job,
    snapshot,
)

router = APIRouter(prefix="/api/projects", tags=["generation"])

# Cron lives under /api/_cron to avoid colliding with /api/projects/{uuid}
cron_router = APIRouter(prefix="/api", tags=["cron"])


# --------------------------------------------------------------------------- #
# Read endpoints
# --------------------------------------------------------------------------- #


class DatasetSummary(BaseModel):
    id: UUID
    idx: int
    title: str
    token_count: int | None
    created_at: datetime


class DatasetDetail(DatasetSummary):
    content: str


class PromptDetail(BaseModel):
    id: UUID
    version: int
    system_text: str
    user_template: str
    output_schema: dict[str, Any]
    notes: str | None
    created_at: datetime


class RunSummary(BaseModel):
    id: UUID
    dataset_id: UUID
    dataset_idx: int
    prompt_id: UUID
    model: str
    structured_output: dict[str, Any] | None
    tokens_in: int | None
    tokens_out: int | None
    latency_ms: int | None
    error: str | None
    created_at: datetime


class GenerationState(BaseModel):
    id: UUID | None = None
    status: str | None = None
    archetype: str | None = None
    instances: list[str] | None = None
    datasets_done: int = 0
    runs_done: int = 0
    prompt_id: UUID | None = None
    error: str | None = None
    error_step: str | None = None
    started_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None


def _ensure_owner(conn: Connection, project_id: UUID, user_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM projects WHERE id = %s AND user_id = %s",
            (project_id, user_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="Project not found")


@router.get("/{project_id}/datasets", response_model=list[DatasetSummary])
def list_datasets(
    project_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> list[DatasetSummary]:
    _ensure_owner(conn, project_id, user_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, idx, title, token_count, created_at
            FROM datasets
            WHERE project_id = %s
            ORDER BY idx ASC
            """,
            (project_id,),
        )
        rows = cur.fetchall()
    return [DatasetSummary(**r) for r in rows]


@router.get("/{project_id}/datasets/{idx}", response_model=DatasetDetail)
def get_dataset(
    project_id: UUID,
    idx: int,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> DatasetDetail:
    _ensure_owner(conn, project_id, user_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, idx, title, content, token_count, created_at
            FROM datasets
            WHERE project_id = %s AND idx = %s
            """,
            (project_id, idx),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return DatasetDetail(**row)


@router.get("/{project_id}/prompt", response_model=PromptDetail | None)
def get_prompt(
    project_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> PromptDetail | None:
    _ensure_owner(conn, project_id, user_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, version, system_text, user_template, output_schema, notes, created_at
            FROM prompts
            WHERE project_id = %s
            ORDER BY version DESC
            LIMIT 1
            """,
            (project_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return PromptDetail(**row)


@router.get("/{project_id}/runs", response_model=list[RunSummary])
def list_runs(
    project_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> list[RunSummary]:
    """Latest run per dataset for the latest prompt version."""
    _ensure_owner(conn, project_id, user_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH latest_prompt AS (
                SELECT id FROM prompts
                WHERE project_id = %s
                ORDER BY version DESC LIMIT 1
            ),
            ranked AS (
                SELECT
                    r.id, r.dataset_id, r.prompt_id, r.model,
                    r.structured_output, r.tokens_in, r.tokens_out,
                    r.latency_ms, r.error, r.created_at,
                    d.idx AS dataset_idx,
                    ROW_NUMBER() OVER (
                        PARTITION BY r.dataset_id ORDER BY r.created_at DESC
                    ) AS rn
                FROM runs r
                JOIN datasets d ON d.id = r.dataset_id
                WHERE r.project_id = %s
                  AND r.prompt_id = (SELECT id FROM latest_prompt)
            )
            SELECT id, dataset_id, dataset_idx, prompt_id, model,
                   structured_output, tokens_in, tokens_out, latency_ms,
                   error, created_at
            FROM ranked
            WHERE rn = 1
            ORDER BY dataset_idx ASC
            """,
            (project_id, project_id),
        )
        rows = cur.fetchall()
    return [RunSummary(**r) for r in rows]


# --------------------------------------------------------------------------- #
# Generation control + polling
# --------------------------------------------------------------------------- #


@router.post("/{project_id}/generate", response_model=GenerationState, status_code=202)
async def start_or_resume_generation(
    project_id: UUID,
    user_id: CurrentUser,
) -> GenerationState:
    """Create the job if needed, then advance it by one step. Subsequent
    polls (and the cron) keep advancing it until terminal."""
    with connection() as conn:
        _ensure_owner(conn, project_id, user_id)
    job = get_or_create_job(project_id)
    await advance(job.id)
    snap = snapshot(project_id) or {}
    return GenerationState(**snap)


@router.get("/{project_id}/generation", response_model=GenerationState)
async def generation_state(
    project_id: UUID,
    user_id: CurrentUser,
) -> GenerationState:
    """Return the latest job snapshot. Lazy-advances so frontend polling
    drives the pipeline forward when the user has the page open."""
    with connection() as conn:
        _ensure_owner(conn, project_id, user_id)
    snap = snapshot(project_id)
    if snap is not None and snap["status"] not in (
        "completed", "failed", "cancelled", None,
    ):
        # Don't await advance for slow steps — best-effort, swallow errors;
        # the cron is the authoritative driver. We DO await so the same
        # request can return a fresher state for the UI.
        try:
            job = await advance(UUID(snap["id"]))
            snap = snapshot(project_id) or snap
        except Exception:  # noqa: BLE001
            pass
    return GenerationState(**(snap or {}))


# --------------------------------------------------------------------------- #
# Cron — Vercel Cron hits this every minute to advance any in-flight jobs
# even when no client is polling.
# --------------------------------------------------------------------------- #


@cron_router.get("/_cron/advance", include_in_schema=False)
async def cron_advance(request: Request) -> dict[str, Any]:
    """Vercel Cron entry. Vercel sends GET with header:
        Authorization: Bearer <CRON_SECRET>
    where CRON_SECRET is the auto-injected env var from Vercel's Crons feature.
    """
    import os
    secret = os.environ.get("CRON_SECRET")
    if not secret:
        raise HTTPException(503, "CRON_SECRET not configured")
    auth = request.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer ") or auth.split(" ", 1)[1] != secret:
        raise HTTPException(401, "Bad cron token")
    touched = await advance_all_in_flight()
    return {"touched": touched}
