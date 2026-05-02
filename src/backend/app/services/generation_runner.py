"""Stateless generation runner — Vercel-deployable.

Each call to `advance(job_id)` does AT MOST ONE step of the pipeline. State
lives in `generation_jobs`. Concurrency safety is a Postgres transaction-
scoped advisory lock keyed by the job UUID — two parallel `advance` calls
on the same job will serialise; one does the work, the other reads the
new state and returns.

State machine
=============

    queued
      → planning              (Sonnet 4.6, ~10s)
      → submitting_datasets   (instant: submit Anthropic Batch)
      → awaiting_datasets     (poll batch; on `ended`, fetch + insert datasets)
      → writing_schema        (Opus 4.7, ~30s — single call)
      → writing_prompt        (Opus 4.7, ~30s — single call)
      → submitting_runs       (instant: submit Anthropic Batch)
      → awaiting_runs         (poll batch; on `ended`, fetch + insert runs)
      → completed | failed

Each step is bounded so a single advance fits inside Vercel's 60s budget.
The `awaiting_*` steps are no-ops while the batch is still in_progress —
the *next* advance call (driven by GET /generation polls or a Vercel Cron)
will check again.
"""
from __future__ import annotations

import logging
import traceback
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import anthropic
from psycopg import Connection
from psycopg.types.json import Jsonb

from app.db import connection
from app.services.generation import (
    BatchItemResult,
    DATASET_COUNT,
    GeneratedDataset,
    GeneratedSchema,
    RUN_MODEL,
    batch_processing_status,
    collect_batch_results,
    generate_prompt,
    generate_schema,
    plan_topics,
    schema_to_json_schema,
    submit_dataset_batch,
    submit_run_batch,
)

log = logging.getLogger("spop.runner")
if not log.handlers:
    h = logging.StreamHandler()
    h.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)s spop.runner %(message)s")
    )
    log.addHandler(h)
log.setLevel(logging.INFO)


TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
IN_FLIGHT_STATUSES = {
    "queued",
    "planning",
    "submitting_datasets",
    "awaiting_datasets",
    "writing_schema",
    "writing_prompt",
    "submitting_runs",
    "awaiting_runs",
}


# --------------------------------------------------------------------------- #
# Job model + DB helpers
# --------------------------------------------------------------------------- #


@dataclass
class JobRow:
    id: UUID
    project_id: UUID
    status: str
    archetype: str | None
    instances: list[str] | None
    dataset_batch_id: str | None
    run_batch_id: str | None
    prompt_id: UUID | None
    datasets_done: int
    runs_done: int
    error: str | None
    error_step: str | None
    started_at: datetime
    updated_at: datetime
    completed_at: datetime | None


JOB_SELECT = """
    id, project_id, status, archetype, instances,
    dataset_batch_id, run_batch_id, prompt_id,
    datasets_done, runs_done,
    error, error_step,
    started_at, updated_at, completed_at
"""


def _row_to_job(r: dict[str, Any]) -> JobRow:
    return JobRow(
        id=r["id"],
        project_id=r["project_id"],
        status=r["status"],
        archetype=r["archetype"],
        instances=r["instances"],
        dataset_batch_id=r["dataset_batch_id"],
        run_batch_id=r["run_batch_id"],
        prompt_id=r["prompt_id"],
        datasets_done=r["datasets_done"],
        runs_done=r["runs_done"],
        error=r["error"],
        error_step=r["error_step"],
        started_at=r["started_at"],
        updated_at=r["updated_at"],
        completed_at=r["completed_at"],
    )


def _get_active_job(conn: Connection, project_id: UUID) -> JobRow | None:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {JOB_SELECT} FROM generation_jobs
            WHERE project_id = %s AND status NOT IN ('completed', 'failed', 'cancelled')
            ORDER BY started_at DESC LIMIT 1
            """,
            (project_id,),
        )
        row = cur.fetchone()
    return _row_to_job(row) if row else None


def _get_latest_job(conn: Connection, project_id: UUID) -> JobRow | None:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {JOB_SELECT} FROM generation_jobs
            WHERE project_id = %s
            ORDER BY started_at DESC LIMIT 1
            """,
            (project_id,),
        )
        row = cur.fetchone()
    return _row_to_job(row) if row else None


def _get_job(conn: Connection, job_id: UUID) -> JobRow:
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {JOB_SELECT} FROM generation_jobs WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise RuntimeError(f"Job {job_id} not found")
    return _row_to_job(row)


def _create_job(conn: Connection, project_id: UUID) -> JobRow:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO generation_jobs (project_id, status)
            VALUES (%s, 'queued')
            RETURNING {JOB_SELECT}
            """,
            (project_id,),
        )
        row = cur.fetchone()
        conn.commit()
    return _row_to_job(row)


def _update(conn: Connection, job_id: UUID, **fields: Any) -> None:
    if not fields:
        return
    sets = ", ".join(f"{k} = %s" for k in fields) + ", updated_at = now()"
    values = list(fields.values()) + [job_id]
    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE generation_jobs SET {sets} WHERE id = %s", tuple(values)
        )
        conn.commit()


def _set_status(conn: Connection, job_id: UUID, status: str) -> None:
    _update(conn, job_id, status=status)


def _set_project_status(
    conn: Connection, project_id: UUID, status: str
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE projects SET status = %s, updated_at = now() WHERE id = %s",
            (status, project_id),
        )
        conn.commit()


def _bump(conn: Connection, job_id: UUID, column: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE generation_jobs SET {column} = {column} + 1, "
            "updated_at = now() WHERE id = %s",
            (job_id,),
        )
        conn.commit()


def _mark_failed(
    conn: Connection, job_id: UUID, project_id: UUID, step: str, err: str
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE generation_jobs
            SET status = 'failed', error = %s, error_step = %s,
                updated_at = now(), completed_at = now()
            WHERE id = %s
            """,
            (err[:4000], step, job_id),
        )
        conn.commit()
    _set_project_status(conn, project_id, "failed")


def _mark_completed(
    conn: Connection, job_id: UUID, project_id: UUID
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE generation_jobs
            SET status = 'completed', updated_at = now(), completed_at = now()
            WHERE id = %s
            """,
            (job_id,),
        )
        conn.commit()
    _set_project_status(conn, project_id, "ready")


# --------------------------------------------------------------------------- #
# Existing-data lookups (resume support)
# --------------------------------------------------------------------------- #


def _existing_dataset_indices(
    conn: Connection, project_id: UUID
) -> set[int]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT idx FROM datasets WHERE project_id = %s",
            (project_id,),
        )
        return {r["idx"] for r in cur.fetchall()}


def _existing_run_dataset_idxs(
    conn: Connection, project_id: UUID, prompt_id: UUID
) -> set[int]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT d.idx FROM runs r
            JOIN datasets d ON d.id = r.dataset_id
            WHERE r.project_id = %s AND r.prompt_id = %s AND r.error IS NULL
            """,
            (project_id, prompt_id),
        )
        return {r["idx"] for r in cur.fetchall()}


def _project_meta(conn: Connection, project_id: UUID) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT domain, difficulty FROM projects WHERE id = %s",
            (project_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise RuntimeError("project missing during generation")
    return row


def _dataset_titles(conn: Connection, project_id: UUID) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT title FROM datasets WHERE project_id = %s ORDER BY idx",
            (project_id,),
        )
        return [r["title"] for r in cur.fetchall()]


def _datasets_full(
    conn: Connection, project_id: UUID
) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, idx, content FROM datasets WHERE project_id = %s "
            "ORDER BY idx",
            (project_id,),
        )
        return cur.fetchall()


def _insert_dataset(
    conn: Connection,
    project_id: UUID,
    idx: int,
    title: str,
    content: str,
) -> UUID:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO datasets (project_id, idx, title, content, token_count)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (project_id, idx) DO UPDATE
              SET title = EXCLUDED.title,
                  content = EXCLUDED.content,
                  token_count = EXCLUDED.token_count
            RETURNING id
            """,
            (project_id, idx, title, content, len(content) // 4),
        )
        row = cur.fetchone()
        conn.commit()
    return row["id"]


def _insert_prompt(
    conn: Connection,
    project_id: UUID,
    schema: GeneratedSchema,
    prompt_obj,
) -> tuple[UUID, int, dict[str, Any]]:
    json_schema = schema_to_json_schema(schema)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM prompts WHERE project_id = %s",
            (project_id,),
        )
        version = cur.fetchone()["v"]
        cur.execute(
            """
            INSERT INTO prompts (project_id, version, system_text, user_template, output_schema, notes)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                project_id, version,
                prompt_obj.system_text, prompt_obj.user_template,
                Jsonb(json_schema), prompt_obj.notes,
            ),
        )
        row = cur.fetchone()
        conn.commit()
    return row["id"], version, json_schema


def _insert_run(
    conn: Connection,
    project_id: UUID,
    prompt_id: UUID,
    dataset_id: UUID,
    item: BatchItemResult,
) -> None:
    if item.error or item.parsed is None:
        params: tuple = (
            project_id, prompt_id, dataset_id, RUN_MODEL,
            None, item.tokens_in, item.tokens_out, None,
            item.error or "unknown batch error",
        )
    else:
        params = (
            project_id, prompt_id, dataset_id, RUN_MODEL,
            Jsonb(item.parsed),
            item.tokens_in, item.tokens_out, None,
            None,
        )
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO runs (
                project_id, prompt_id, dataset_id, model,
                structured_output, tokens_in, tokens_out, latency_ms, error
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            params,
        )
        conn.commit()


# --------------------------------------------------------------------------- #
# Public surface used by the router
# --------------------------------------------------------------------------- #


def get_or_create_job(project_id: UUID) -> JobRow:
    """Return the active job for a project, creating one if none exists.
    Idempotent: callers can hit this on every request."""
    with connection() as conn:
        existing = _get_active_job(conn, project_id)
        if existing is not None:
            return existing
        return _create_job(conn, project_id)


def latest_job(project_id: UUID) -> JobRow | None:
    with connection() as conn:
        return _get_latest_job(conn, project_id)


def snapshot(project_id: UUID) -> dict[str, Any] | None:
    """Snapshot the latest job state for the polling endpoint."""
    job = latest_job(project_id)
    if job is None:
        return None
    return _serialize_job(job)


def _serialize_job(job: JobRow) -> dict[str, Any]:
    return {
        "id": str(job.id),
        "status": job.status,
        "archetype": job.archetype,
        "instances": job.instances,
        "datasets_done": job.datasets_done,
        "runs_done": job.runs_done,
        "prompt_id": str(job.prompt_id) if job.prompt_id else None,
        "error": job.error,
        "error_step": job.error_step,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "completed_at": (
            job.completed_at.isoformat() if job.completed_at else None
        ),
    }


# --------------------------------------------------------------------------- #
# advance() — the heart of the runner
# --------------------------------------------------------------------------- #


def _job_lock_key(job_id: UUID) -> tuple[int, int]:
    """Postgres advisory lock takes two int4s; split the UUID into halves."""
    h = job_id.int
    return (h >> 96) & 0x7FFFFFFF, (h >> 64) & 0x7FFFFFFF


async def advance(job_id: UUID) -> JobRow:
    """Run at most one step. Idempotent / lock-protected. Returns the
    current state after the step (or the same state if locked / terminal /
    waiting)."""
    # Per-job advisory lock to serialise concurrent advances on this job.
    # Any other concurrent caller for the SAME job will skip and return.
    with connection() as conn:
        with conn.cursor() as cur:
            a, b = _job_lock_key(job_id)
            cur.execute("SELECT pg_try_advisory_xact_lock(%s, %s)", (a, b))
            got = cur.fetchone()["pg_try_advisory_xact_lock"]
        if not got:
            log.info("advance skipped (lock held) job=%s", job_id)
            return _get_job(conn, job_id)
        job = _get_job(conn, job_id)

        if job.status in TERMINAL_STATUSES:
            return job

        try:
            log.info("advance step status=%s job=%s", job.status, job.id)
            client = anthropic.AsyncAnthropic()
            await _step(client, job, conn)
            return _get_job(conn, job_id)
        except Exception as e:  # noqa: BLE001
            tb = traceback.format_exc()
            log.error(
                "advance step failed status=%s job=%s err=%r\n%s",
                job.status, job.id, e, tb,
            )
            _mark_failed(
                conn, job.id, job.project_id, job.status,
                f"{type(e).__name__}: {e}",
            )
            return _get_job(conn, job_id)


async def _step(
    client: anthropic.AsyncAnthropic, job: JobRow, conn: Connection
) -> None:
    project_id = job.project_id

    if job.status == "queued":
        _set_status(conn, job.id, "planning")
        _set_project_status(conn, project_id, "generating")
        return

    if job.status == "planning":
        if job.archetype and job.instances:
            _set_status(conn, job.id, "submitting_datasets")
            return
        meta = _project_meta(conn, project_id)
        plan = await plan_topics(client, meta["domain"], meta["difficulty"])
        _update(
            conn, job.id,
            archetype=plan.archetype,
            instances=Jsonb(list(plan.instances)),
            status="submitting_datasets",
        )
        return

    if job.status == "submitting_datasets":
        # Submit only the indices we don't already have.
        already = _existing_dataset_indices(conn, project_id)
        missing = [i for i in range(1, DATASET_COUNT + 1) if i not in already]
        if not missing:
            _set_status(conn, job.id, "writing_schema")
            return
        meta = _project_meta(conn, project_id)
        batch_id = await submit_dataset_batch(
            client,
            domain=meta["domain"],
            archetype=job.archetype or "",
            instances=job.instances or [],
            indices=missing,
            difficulty=meta["difficulty"],
        )
        _update(
            conn, job.id,
            dataset_batch_id=batch_id,
            status="awaiting_datasets",
        )
        return

    if job.status == "awaiting_datasets":
        if job.dataset_batch_id is None:
            _set_status(conn, job.id, "submitting_datasets")
            return
        status = await batch_processing_status(client, job.dataset_batch_id)
        if status != "ended":
            log.info(
                "dataset batch %s still %s (job=%s)",
                job.dataset_batch_id, status, job.id,
            )
            return
        results = await collect_batch_results(client, job.dataset_batch_id)
        succeeded = 0
        errors: list[str] = []
        for item in results:
            try:
                idx = int(item.custom_id.split("-", 1)[1])
            except (ValueError, IndexError):
                errors.append(f"bad custom_id: {item.custom_id}")
                continue
            if item.parsed is None:
                err = item.error or "unknown error"
                errors.append(f"item {idx}: {err}")
                log.warning(
                    "dataset batch item failed idx=%d err=%s job=%s",
                    idx, err, job.id,
                )
                continue
            title = str(item.parsed.get("title") or f"Dataset {idx}")[:200]
            content = str(item.parsed.get("content") or "")
            _insert_dataset(conn, project_id, idx, title, content)
            _bump(conn, job.id, "datasets_done")
            succeeded += 1
        # Fail-fast: if zero items succeeded in this batch, the failure is
        # systematic (bad params, schema mismatch, permission, etc.).
        # Resubmitting will produce identical errors. Abort the job with
        # the first error message so the user sees the real cause.
        if succeeded == 0 and results:
            sample = errors[0] if errors else "all items failed without detail"
            raise RuntimeError(
                f"dataset batch returned {len(results)} failures; first error: {sample}"
            )
        still_missing = [
            i for i in range(1, DATASET_COUNT + 1)
            if i not in _existing_dataset_indices(conn, project_id)
        ]
        if still_missing:
            log.info(
                "dataset batch: %d succeeded, %d still missing — resubmitting job=%s",
                succeeded, len(still_missing), job.id,
            )
            _update(
                conn, job.id,
                dataset_batch_id=None,
                status="submitting_datasets",
            )
            return
        _set_status(conn, job.id, "writing_schema")
        return

    if job.status == "writing_schema":
        # Schema is regenerated each advance — it lives in memory between
        # this step and writing_prompt (we don't persist it; instead the
        # prompt step re-derives the schema from the same dataset titles).
        # Move directly to writing_prompt; the prompt step will handle both.
        _set_status(conn, job.id, "writing_prompt")
        return

    if job.status == "writing_prompt":
        if job.prompt_id is not None:
            _set_status(conn, job.id, "submitting_runs")
            return
        meta = _project_meta(conn, project_id)
        titles = _dataset_titles(conn, project_id)
        schema = await generate_schema(
            client, meta["domain"], job.archetype or "", titles, meta["difficulty"],
        )
        prompt_obj = await generate_prompt(
            client, meta["domain"], schema, meta["difficulty"],
        )
        prompt_id, _v, _js = _insert_prompt(
            conn, project_id, schema, prompt_obj,
        )
        _update(
            conn, job.id,
            prompt_id=prompt_id,
            status="submitting_runs",
        )
        return

    if job.status == "submitting_runs":
        assert job.prompt_id is not None, "prompt should exist by now"
        # Submit only datasets that don't yet have a successful run.
        already = _existing_run_dataset_idxs(conn, project_id, job.prompt_id)
        ds_rows = _datasets_full(conn, project_id)
        missing = [r for r in ds_rows if r["idx"] not in already]
        if not missing:
            _mark_completed(conn, job.id, project_id)
            return
        with conn.cursor() as cur:
            cur.execute(
                "SELECT system_text, user_template, output_schema "
                "FROM prompts WHERE id = %s",
                (job.prompt_id,),
            )
            prow = cur.fetchone()
        batch_id = await submit_run_batch(
            client,
            system_text=prow["system_text"],
            user_template=prow["user_template"],
            json_schema=prow["output_schema"],
            datasets=[
                (r["idx"], str(r["id"]), r["content"]) for r in missing
            ],
        )
        _update(
            conn, job.id,
            run_batch_id=batch_id,
            status="awaiting_runs",
        )
        return

    if job.status == "awaiting_runs":
        assert job.prompt_id is not None
        if job.run_batch_id is None:
            _set_status(conn, job.id, "submitting_runs")
            return
        status = await batch_processing_status(client, job.run_batch_id)
        if status != "ended":
            log.info(
                "run batch %s still %s (job=%s)",
                job.run_batch_id, status, job.id,
            )
            return
        results = await collect_batch_results(client, job.run_batch_id)
        succeeded = 0
        errors: list[str] = []
        for item in results:
            try:
                _, _idx_str, dataset_id = item.custom_id.split("-", 2)
                dataset_uuid = UUID(dataset_id)
            except (ValueError, IndexError):
                errors.append(f"bad custom_id: {item.custom_id}")
                continue
            _insert_run(
                conn, project_id, job.prompt_id, dataset_uuid, item,
            )
            if item.parsed is not None and item.error is None:
                _bump(conn, job.id, "runs_done")
                succeeded += 1
            else:
                err = item.error or "unknown error"
                errors.append(f"item {dataset_id}: {err}")
                log.warning(
                    "run batch item failed dataset=%s err=%s job=%s",
                    dataset_id, err, job.id,
                )
        if succeeded == 0 and results:
            sample = errors[0] if errors else "all items failed without detail"
            raise RuntimeError(
                f"run batch returned {len(results)} failures; first error: {sample}"
            )
        still_missing = [
            r for r in _datasets_full(conn, project_id)
            if r["idx"] not in _existing_run_dataset_idxs(
                conn, project_id, job.prompt_id
            )
        ]
        if still_missing:
            log.info(
                "run batch: %d succeeded, %d still missing — resubmitting job=%s",
                succeeded, len(still_missing), job.id,
            )
            _update(
                conn, job.id,
                run_batch_id=None,
                status="submitting_runs",
            )
            return
        _mark_completed(conn, job.id, project_id)
        return

    raise RuntimeError(f"unknown job status: {job.status}")


# --------------------------------------------------------------------------- #
# Cron entry point
# --------------------------------------------------------------------------- #


async def advance_all_in_flight() -> int:
    """Advance every project that has an active job. Returns the number
    of jobs touched. Designed for a Vercel Cron entry — cheap to run on
    short intervals because each advance is bounded ≤ 60s and locked."""
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id FROM generation_jobs
            WHERE status NOT IN ('completed', 'failed', 'cancelled')
            ORDER BY started_at ASC
            """
        )
        rows = cur.fetchall()
    job_ids = [r["id"] for r in rows]
    log.info("cron advance touching %d job(s)", len(job_ids))
    for job_id in job_ids:
        try:
            await advance(job_id)
        except Exception as e:  # noqa: BLE001
            log.error("cron advance failed job=%s err=%r", job_id, e)
    return len(job_ids)
