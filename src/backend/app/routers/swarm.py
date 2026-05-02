"""Swarm playground routes: create/list/get runs, start/pause control, and
NDJSON live event streaming."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from app.auth import CurrentUser
from app.db import db_conn
from app.services import swarm as swarm_service
from app.services.swarm_broker import broker

router = APIRouter(prefix="/api/projects", tags=["swarm"])


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #


SwarmType = Literal["aco", "pso", "abc", "firefly"]
RunModel = Literal["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]
ThoughtLevel = Literal["minimal", "standard", "deep", "extreme"]
RunStatus = Literal["idle", "running", "paused", "completed", "failed"]


class SwarmRunConfig(BaseModel):
    swarm_type: SwarmType = "aco"
    model: RunModel = "claude-sonnet-4-6"
    num_agents: int = Field(default=8, ge=2, le=64)
    thought_level: ThoughtLevel = "standard"
    randomness: float = Field(default=0.3, ge=0.0, le=1.0)
    pheromone_strength: float = Field(default=0.6, ge=0.0, le=1.0)


class SwarmRunSummary(BaseModel):
    id: UUID
    project_id: UUID
    config: SwarmRunConfig
    status: RunStatus
    current_turn: int
    best_score: float | None
    created_at: datetime
    updated_at: datetime


class SwarmRunDetail(SwarmRunSummary):
    best_attempt_id: UUID | None
    best_system_text: str | None
    best_user_template: str | None
    error: str | None


class SwarmAttempt(BaseModel):
    id: UUID
    turn: int
    agent_idx: int
    parent_attempt_id: UUID | None
    status: str
    score: float | None
    pheromone: float
    x: float | None
    y: float | None
    system_text: str | None
    user_template: str | None
    predicted_output: dict[str, Any] | None
    error: str | None


# --------------------------------------------------------------------------- #
# Auth helper
# --------------------------------------------------------------------------- #


def _ensure_owner(conn: Connection, project_id: UUID, user_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM projects WHERE id = %s AND user_id = %s",
            (project_id, user_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="Project not found")


def _ensure_run_owner(
    conn: Connection, project_id: UUID, run_id: UUID, user_id: str
) -> None:
    _ensure_owner(conn, project_id, user_id)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM swarm_runs WHERE id = %s AND project_id = %s",
            (run_id, project_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="Run not found")


# --------------------------------------------------------------------------- #
# REST
# --------------------------------------------------------------------------- #


@router.post(
    "/{project_id}/swarm-runs", response_model=SwarmRunSummary, status_code=201
)
def create_run(
    project_id: UUID,
    body: SwarmRunConfig,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> SwarmRunSummary:
    _ensure_owner(conn, project_id, user_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO swarm_runs (project_id, config)
            VALUES (%s, %s)
            RETURNING id, project_id, config, status, current_turn,
                      best_score, created_at, updated_at
            """,
            (project_id, Jsonb(body.model_dump())),
        )
        row = cur.fetchone()
    conn.commit()
    return SwarmRunSummary(**row)


@router.get("/{project_id}/swarm-runs", response_model=list[SwarmRunSummary])
def list_runs(
    project_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> list[SwarmRunSummary]:
    _ensure_owner(conn, project_id, user_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, project_id, config, status, current_turn,
                   best_score, created_at, updated_at
            FROM swarm_runs
            WHERE project_id = %s
            ORDER BY created_at DESC
            """,
            (project_id,),
        )
        rows = cur.fetchall()
    return [SwarmRunSummary(**r) for r in rows]


@router.get(
    "/{project_id}/swarm-runs/{run_id}", response_model=SwarmRunDetail
)
def get_run(
    project_id: UUID,
    run_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> SwarmRunDetail:
    _ensure_run_owner(conn, project_id, run_id, user_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT r.id, r.project_id, r.config, r.status, r.current_turn,
                   r.best_attempt_id, r.best_score, r.error,
                   r.created_at, r.updated_at,
                   ba.system_text AS best_system_text,
                   ba.user_template AS best_user_template
            FROM swarm_runs r
            LEFT JOIN swarm_attempts ba ON ba.id = r.best_attempt_id
            WHERE r.id = %s
            """,
            (run_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return SwarmRunDetail(**row)


@router.get(
    "/{project_id}/swarm-runs/{run_id}/attempts",
    response_model=list[SwarmAttempt],
)
def list_attempts(
    project_id: UUID,
    run_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> list[SwarmAttempt]:
    _ensure_run_owner(conn, project_id, run_id, user_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, turn, agent_idx, parent_attempt_id, status,
                   score, pheromone, x, y,
                   system_text, user_template, predicted_output, error
            FROM swarm_attempts
            WHERE run_id = %s
            ORDER BY turn, agent_idx
            """,
            (run_id,),
        )
        rows = cur.fetchall()
    return [SwarmAttempt(**r) for r in rows]


@router.post("/{project_id}/swarm-runs/{run_id}/start")
def start_run(
    project_id: UUID,
    run_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> dict[str, Any]:
    _ensure_run_owner(conn, project_id, run_id, user_id)
    started = swarm_service.start_run(run_id)
    return {"started": started, "status": swarm_service._get_run_status(run_id)}


@router.post("/{project_id}/swarm-runs/{run_id}/pause")
async def pause_run(
    project_id: UUID,
    run_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> dict[str, Any]:
    _ensure_run_owner(conn, project_id, run_id, user_id)
    await swarm_service.request_pause(run_id)
    return {"status": swarm_service._get_run_status(run_id)}


@router.delete(
    "/{project_id}/swarm-runs/{run_id}",
    status_code=204,
    response_model=None,
)
def delete_run(
    project_id: UUID,
    run_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> None:
    _ensure_run_owner(conn, project_id, run_id, user_id)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM swarm_runs WHERE id = %s", (run_id,))
    conn.commit()


# --------------------------------------------------------------------------- #
# Streaming
# --------------------------------------------------------------------------- #


def _ndjson(event: dict[str, Any]) -> bytes:
    return (json.dumps(event, default=str) + "\n").encode("utf-8")


@router.post("/{project_id}/swarm-runs/{run_id}/stream")
async def stream(
    project_id: UUID,
    run_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> StreamingResponse:
    _ensure_run_owner(conn, project_id, run_id, user_id)

    queue = broker.subscribe(run_id)

    async def gen():
        try:
            # Send initial snapshot so the UI has full state without an
            # extra REST call.
            snap = swarm_service.snapshot(run_id)
            yield _ndjson(snap)
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield _ndjson(event)
        finally:
            broker.unsubscribe(run_id, queue)

    return StreamingResponse(gen(), media_type="application/x-ndjson")
