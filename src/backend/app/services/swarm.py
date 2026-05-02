"""Ant-colony optimisation orchestrator for prompt reverse-engineering.

A `swarm_run` runs a `run_loop` background task. Each turn fires K agents
in parallel: each agent picks a parent prompt from the pool weighted by
pheromone (with epsilon-greedy randomness), drafts a new prompt that maps
training (document, gold_output) pairs to the gold output, runs the
candidate against a held-out test document, and is scored.

After the turn:
  • new attempts get pheromone Δτ = Q · score
  • all attempts evaporate by ρ = clamp(1 - Q, 0.05, 0.5)
  • best ever is surfaced

Pause/resume is between turns; `_running_tasks` tracks the asyncio task
per run so /pause/start are idempotent.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import anthropic
from psycopg.types.json import Jsonb

from app.db import connection
from app.services.generation import (
    GeneratedPrompt,
    execute_prompt,
)
from app.services.layout import embed_prompt, project_pca_2d
from app.services.scoring import score_against_gold
from app.services.swarm_broker import broker

logger = logging.getLogger("spop.swarm")


# --------------------------------------------------------------------------- #
# Config & constants
# --------------------------------------------------------------------------- #


TRAINING_SAMPLE_SIZE = 3
TEST_DATASET_IDX = 10           # held-out for scoring
PHEROMONE_ALPHA = 1.0
EVAPORATION_MIN = 0.05
EVAPORATION_MAX = 0.50
RELAYOUT_EVERY = 5

THINKING_BUDGET = {
    "minimal": 0,
    "standard": 2_000,
    "deep": 8_000,
    "extreme": 20_000,
}


@dataclass
class RunConfig:
    swarm_type: str
    model: str
    num_agents: int
    thought_level: str
    randomness: float
    pheromone_strength: float

    @classmethod
    def from_jsonb(cls, raw: dict[str, Any]) -> "RunConfig":
        return cls(
            swarm_type=raw.get("swarm_type", "aco"),
            model=raw.get("model", "claude-sonnet-4-6"),
            num_agents=int(raw.get("num_agents", 8)),
            thought_level=raw.get("thought_level", "standard"),
            randomness=float(raw.get("randomness", 0.3)),
            pheromone_strength=float(raw.get("pheromone_strength", 0.6)),
        )


@dataclass
class PoolEntry:
    id: UUID
    system_text: str
    user_template: str
    score: float
    pheromone: float


# --------------------------------------------------------------------------- #
# Process-local task registry
# --------------------------------------------------------------------------- #


_running_tasks: dict[UUID, asyncio.Task[None]] = {}


def is_running(run_id: UUID) -> bool:
    task = _running_tasks.get(run_id)
    return task is not None and not task.done()


# --------------------------------------------------------------------------- #
# DB helpers (each takes a fresh connection — never held across awaits)
# --------------------------------------------------------------------------- #


def _set_run_status(run_id: UUID, status: str, error: str | None = None) -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE swarm_runs
            SET status = %s, error = %s, updated_at = now()
            WHERE id = %s
            """,
            (status, error, run_id),
        )
        conn.commit()


def _get_run_status(run_id: UUID) -> str | None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM swarm_runs WHERE id = %s", (run_id,))
        row = cur.fetchone()
    return row["status"] if row else None


def _load_run(run_id: UUID) -> tuple[UUID, RunConfig, int]:
    """Return (project_id, config, current_turn)."""
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT project_id, config, current_turn FROM swarm_runs WHERE id = %s",
            (run_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise RuntimeError(f"swarm_run {run_id} not found")
    return row["project_id"], RunConfig.from_jsonb(row["config"]), int(row["current_turn"])


def _load_pool(run_id: UUID) -> list[PoolEntry]:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, system_text, user_template, score, pheromone
            FROM swarm_attempts
            WHERE run_id = %s AND status = 'done' AND score IS NOT NULL
            """,
            (run_id,),
        )
        rows = cur.fetchall()
    return [
        PoolEntry(
            id=r["id"],
            system_text=r["system_text"] or "",
            user_template=r["user_template"] or "",
            score=float(r["score"]),
            pheromone=float(r["pheromone"]),
        )
        for r in rows
    ]


def _load_project_assets(
    project_id: UUID,
) -> tuple[list[tuple[UUID, int, str, dict[str, Any]]], dict[str, Any]]:
    """Return (datasets, json_schema). datasets = [(id, idx, content, gold_output), ...]
    where gold_output comes from the latest run for the latest prompt."""
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, version, output_schema FROM prompts
            WHERE project_id = %s
            ORDER BY version DESC LIMIT 1
            """,
            (project_id,),
        )
        prompt_row = cur.fetchone()
        if prompt_row is None:
            raise RuntimeError("project has no prompt yet — generate first")
        latest_prompt_id = prompt_row["id"]
        json_schema = prompt_row["output_schema"]

        cur.execute(
            """
            WITH latest_run_per_dataset AS (
              SELECT DISTINCT ON (r.dataset_id)
                r.dataset_id, r.structured_output
              FROM runs r
              WHERE r.project_id = %s AND r.prompt_id = %s
              ORDER BY r.dataset_id, r.created_at DESC
            )
            SELECT d.id, d.idx, d.content, lr.structured_output AS gold
            FROM datasets d
            LEFT JOIN latest_run_per_dataset lr ON lr.dataset_id = d.id
            WHERE d.project_id = %s
            ORDER BY d.idx
            """,
            (project_id, latest_prompt_id, project_id),
        )
        rows = cur.fetchall()
    datasets: list[tuple[UUID, int, str, dict[str, Any]]] = []
    for r in rows:
        if r["gold"] is None:
            continue
        datasets.append((r["id"], int(r["idx"]), r["content"], r["gold"]))
    return datasets, json_schema


def _insert_pending_attempt(
    run_id: UUID,
    turn: int,
    agent_idx: int,
    parent_attempt_id: UUID | None,
) -> UUID:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO swarm_attempts
              (run_id, turn, agent_idx, parent_attempt_id, status)
            VALUES (%s, %s, %s, %s, 'pending')
            ON CONFLICT (run_id, turn, agent_idx) DO UPDATE
              SET parent_attempt_id = EXCLUDED.parent_attempt_id,
                  status = 'pending',
                  error = NULL
            RETURNING id
            """,
            (run_id, turn, agent_idx, parent_attempt_id),
        )
        row = cur.fetchone()
        conn.commit()
    return row["id"]


def _patch_attempt_status(attempt_id: UUID, status: str) -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE swarm_attempts SET status = %s WHERE id = %s",
            (status, attempt_id),
        )
        conn.commit()


def _store_attempt_result(
    attempt_id: UUID,
    *,
    system_text: str,
    user_template: str,
    training_dataset_ids: list[UUID],
    test_dataset_id: UUID,
    predicted_output: dict[str, Any],
    score: float,
    pheromone: float,
    embedding: list[float],
) -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE swarm_attempts
            SET status = 'done',
                system_text = %s,
                user_template = %s,
                training_dataset_ids = %s,
                test_dataset_id = %s,
                predicted_output = %s,
                score = %s,
                pheromone = %s,
                embedding = %s,
                finished_at = now()
            WHERE id = %s
            """,
            (
                system_text,
                user_template,
                training_dataset_ids,
                test_dataset_id,
                Jsonb(predicted_output),
                score,
                pheromone,
                embedding,
                attempt_id,
            ),
        )
        conn.commit()


def _store_attempt_failure(attempt_id: UUID, error: str) -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE swarm_attempts
            SET status = 'failed', error = %s, finished_at = now()
            WHERE id = %s
            """,
            (error, attempt_id),
        )
        conn.commit()


def _evaporate(run_id: UUID, rho: float) -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE swarm_attempts SET pheromone = pheromone * %s WHERE run_id = %s",
            (1.0 - rho, run_id),
        )
        conn.commit()


def _bump_turn(run_id: UUID, turn: int) -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE swarm_runs SET current_turn = %s, updated_at = now() WHERE id = %s",
            (turn, run_id),
        )
        conn.commit()


def _maybe_update_best(run_id: UUID) -> tuple[UUID, float] | None:
    """Re-pick best by raw score across all attempts. Returns (id, score) if changed."""
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, score
            FROM swarm_attempts
            WHERE run_id = %s AND status = 'done' AND score IS NOT NULL
            ORDER BY score DESC, finished_at ASC
            LIMIT 1
            """,
            (run_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cur.execute(
            "SELECT best_attempt_id, best_score FROM swarm_runs WHERE id = %s",
            (run_id,),
        )
        run_row = cur.fetchone()
        if run_row and run_row["best_attempt_id"] == row["id"]:
            return None
        cur.execute(
            "UPDATE swarm_runs SET best_attempt_id = %s, best_score = %s, updated_at = now() WHERE id = %s",
            (row["id"], row["score"], run_id),
        )
        conn.commit()
    return row["id"], float(row["score"])


def _load_attempt_with_xy(attempt_id: UUID) -> dict[str, Any] | None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, system_text, user_template, score
            FROM swarm_attempts WHERE id = %s
            """,
            (attempt_id,),
        )
        return cur.fetchone()


def _all_attempt_embeddings(
    run_id: UUID,
) -> list[tuple[UUID, list[float]]]:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, embedding
            FROM swarm_attempts
            WHERE run_id = %s AND embedding IS NOT NULL
            ORDER BY started_at
            """,
            (run_id,),
        )
        rows = cur.fetchall()
    return [(r["id"], list(r["embedding"])) for r in rows]


def _persist_layout(coords: list[tuple[UUID, float, float]]) -> None:
    if not coords:
        return
    with connection() as conn, conn.cursor() as cur:
        for attempt_id, x, y in coords:
            cur.execute(
                "UPDATE swarm_attempts SET x = %s, y = %s WHERE id = %s",
                (x, y, attempt_id),
            )
        conn.commit()


# --------------------------------------------------------------------------- #
# ACO selection
# --------------------------------------------------------------------------- #


def _select_parent(pool: list[PoolEntry], epsilon: float) -> PoolEntry | None:
    if not pool:
        return None
    if random.random() < epsilon:
        return random.choice(pool)
    weights = [max(p.pheromone, 0.0) ** PHEROMONE_ALPHA for p in pool]
    total = sum(weights)
    if total <= 0:
        return random.choice(pool)
    r = random.random() * total
    acc = 0.0
    for entry, w in zip(pool, weights):
        acc += w
        if acc >= r:
            return entry
    return pool[-1]


# --------------------------------------------------------------------------- #
# Agent draft
# --------------------------------------------------------------------------- #


_SYSTEM = (
    "You are an expert at REVERSE-ENGINEERING structured-extraction prompts.\n"
    "You are shown several (document, expected_output) pairs and the target "
    "JSON Schema. Write the system + user prompt that, when run on each "
    "document, would produce the expected output. The user template MUST "
    "contain the literal string '{{document}}' where the document content "
    "will be substituted at runtime."
)


def _format_samples(samples: list[tuple[str, dict[str, Any]]]) -> str:
    parts: list[str] = []
    for i, (doc, gold) in enumerate(samples, 1):
        parts.append(
            f"--- Sample {i} ---\n"
            f"<document>\n{doc[:6000]}\n</document>\n\n"
            f"<expected_output>\n{json.dumps(gold, indent=2)}\n</expected_output>"
        )
    return "\n\n".join(parts)


async def draft_candidate_prompt(
    client: anthropic.AsyncAnthropic,
    *,
    model: str,
    thought_level: str,
    samples: list[tuple[str, dict[str, Any]]],
    json_schema: dict[str, Any],
    parent: PoolEntry | None,
    randomness: float,
) -> GeneratedPrompt:
    """Ask the agent LLM to write a prompt that maps each sample's document
    to its expected_output. If a parent is given, it's shown as a seed."""
    user_lines: list[str] = []
    user_lines.append(
        f"Target JSON Schema (Draft 2020-12):\n```json\n{json.dumps(json_schema)}\n```"
    )
    user_lines.append(_format_samples(samples))
    if parent is not None:
        user_lines.append(
            f"Here is a previous attempt that scored {parent.score:.2f}:\n\n"
            f"<previous_system>\n{parent.system_text}\n</previous_system>\n\n"
            f"<previous_user_template>\n{parent.user_template}\n</previous_user_template>\n\n"
            "Improve it. Keep what's working. Be willing to rewrite weak sections."
        )
    if randomness > 0.5:
        user_lines.append(
            "Be willing to take creative risks — try a meaningfully different "
            "structure or rhetorical approach than the previous attempt."
        )
    user_lines.append(
        "Now write the new prompt. The user_template MUST contain '{{document}}'."
    )
    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": 8000,
        "system": _SYSTEM,
        "messages": [{"role": "user", "content": "\n\n".join(user_lines)}],
        "output_format": GeneratedPrompt,
    }
    budget = THINKING_BUDGET.get(thought_level, 0)
    if budget > 0:
        kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
        # Anthropic requires max_tokens > thinking budget.
        kwargs["max_tokens"] = max(kwargs["max_tokens"], budget + 4000)
    response = await client.messages.parse(**kwargs)
    return response.parsed_output


# --------------------------------------------------------------------------- #
# Turn loop
# --------------------------------------------------------------------------- #


async def _run_one_turn(
    client: anthropic.AsyncAnthropic,
    run_id: UUID,
    turn: int,
    cfg: RunConfig,
    pool: list[PoolEntry],
    datasets: list[tuple[UUID, int, str, dict[str, Any]]],
    json_schema: dict[str, Any],
) -> None:
    test = next((d for d in datasets if d[1] == TEST_DATASET_IDX), None)
    training_pool = [d for d in datasets if d[1] != TEST_DATASET_IDX]
    if test is None or len(training_pool) < TRAINING_SAMPLE_SIZE:
        raise RuntimeError(
            "Not enough scored datasets — need at least dataset #10 (test) and 3 training docs."
        )
    test_id, _test_idx, test_content, test_gold = test

    turn_started = time.monotonic()
    logger.info(
        "turn_started run=%s turn=%s K=%d pool_size=%d",
        run_id, turn, cfg.num_agents, len(pool),
    )
    await broker.publish(run_id, {"type": "turn_started", "turn": turn})

    parents = [_select_parent(pool, cfg.randomness) for _ in range(cfg.num_agents)]
    parents_with_score = sum(1 for p in parents if p is not None)
    logger.debug(
        "turn=%s parents_chosen=%d/%d (%.0f%% had a parent)",
        turn, parents_with_score, cfg.num_agents,
        100 * parents_with_score / max(cfg.num_agents, 1),
    )

    async def one_agent(agent_idx: int, parent: PoolEntry | None) -> None:
        agent_started = time.monotonic()
        attempt_id = _insert_pending_attempt(
            run_id, turn, agent_idx, parent.id if parent else None
        )
        logger.info(
            "agent_started run=%s turn=%s agent=%d parent=%s parent_score=%s",
            run_id, turn, agent_idx,
            str(parent.id) if parent else "—",
            f"{parent.score:.3f}" if parent else "—",
        )
        await broker.publish(
            run_id,
            {
                "type": "agent_started",
                "turn": turn,
                "agent_idx": agent_idx,
                "attempt_id": str(attempt_id),
                "parent_attempt_id": str(parent.id) if parent else None,
                "parent_score": parent.score if parent else None,
                "parent_xy": None,
            },
        )
        try:
            samples_picked = random.sample(training_pool, k=TRAINING_SAMPLE_SIZE)
            samples = [(d[2], d[3]) for d in samples_picked]
            training_ids = [d[0] for d in samples_picked]

            _patch_attempt_status(attempt_id, "drafting")
            await broker.publish(
                run_id,
                {"type": "agent_progress", "turn": turn, "agent_idx": agent_idx, "phase": "drafting"},
            )

            draft_started = time.monotonic()
            cand = await draft_candidate_prompt(
                client,
                model=cfg.model,
                thought_level=cfg.thought_level,
                samples=samples,
                json_schema=json_schema,
                parent=parent,
                randomness=cfg.randomness,
            )
            logger.info(
                "agent_drafted run=%s turn=%s agent=%d draft_ms=%d sys_chars=%d user_chars=%d",
                run_id, turn, agent_idx,
                int((time.monotonic() - draft_started) * 1000),
                len(cand.system_text or ""), len(cand.user_template or ""),
            )

            await broker.publish(
                run_id,
                {
                    "type": "agent_drafted",
                    "turn": turn,
                    "agent_idx": agent_idx,
                    "attempt_id": str(attempt_id),
                    "system_preview": cand.system_text[:200],
                    "user_preview": cand.user_template[:200],
                },
            )

            _patch_attempt_status(attempt_id, "scoring")
            await broker.publish(
                run_id,
                {"type": "agent_progress", "turn": turn, "agent_idx": agent_idx, "phase": "scoring"},
            )

            run_result = await execute_prompt(
                client,
                cand.system_text,
                cand.user_template,
                test_content,
                json_schema,
            )
            score = score_against_gold(
                run_result.structured_output, test_gold, json_schema
            )

            embedding = await embed_prompt(cand.system_text, cand.user_template)
            pheromone = cfg.pheromone_strength * score
            logger.info(
                "agent_scored run=%s turn=%s agent=%d score=%.3f phero=%.3f exec_ms=%d total_ms=%d",
                run_id, turn, agent_idx, score, pheromone,
                run_result.latency_ms,
                int((time.monotonic() - agent_started) * 1000),
            )

            _store_attempt_result(
                attempt_id,
                system_text=cand.system_text,
                user_template=cand.user_template,
                training_dataset_ids=training_ids,
                test_dataset_id=test_id,
                predicted_output=run_result.structured_output,
                score=score,
                pheromone=pheromone,
                embedding=embedding,
            )

            await broker.publish(
                run_id,
                {
                    "type": "agent_scored",
                    "turn": turn,
                    "agent_idx": agent_idx,
                    "attempt_id": str(attempt_id),
                    "score": score,
                    "pheromone": pheromone,
                    "latency_ms": run_result.latency_ms,
                    "predicted_output": run_result.structured_output,
                },
            )
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
            logger.exception(
                "agent_failed run=%s turn=%s agent=%d err=%s",
                run_id, turn, agent_idx, err,
            )
            _store_attempt_failure(attempt_id, err)
            await broker.publish(
                run_id,
                {
                    "type": "agent_failed",
                    "turn": turn,
                    "agent_idx": agent_idx,
                    "attempt_id": str(attempt_id),
                    "error": err,
                },
            )

    await asyncio.gather(*[one_agent(i, p) for i, p in enumerate(parents)])

    rho = max(EVAPORATION_MIN, min(EVAPORATION_MAX, 1.0 - cfg.pheromone_strength))
    _evaporate(run_id, rho)
    _bump_turn(run_id, turn)
    logger.debug("evaporated run=%s turn=%s rho=%.3f", run_id, turn, rho)

    # Layout: project all embeddings to 2D and emit the new coordinates.
    embeds = _all_attempt_embeddings(run_id)
    if embeds:
        coords = project_pca_2d([v for _, v in embeds])
        triples = [(aid, x, y) for (aid, _), (x, y) in zip(embeds, coords)]
        _persist_layout(triples)
        logger.debug("layout updated run=%s turn=%s n_points=%d", run_id, turn, len(triples))
        await broker.publish(
            run_id,
            {
                "type": "relayout",
                "turn": turn,
                "points": [{"id": str(aid), "x": x, "y": y} for aid, x, y in triples],
            },
        )

    best = _maybe_update_best(run_id)
    if best is not None:
        logger.info(
            "best_updated run=%s turn=%s attempt=%s score=%.3f",
            run_id, turn, best[0], best[1],
        )
        attempt_row = _load_attempt_with_xy(best[0])
        if attempt_row is not None:
            await broker.publish(
                run_id,
                {
                    "type": "best_updated",
                    "attempt_id": str(attempt_row["id"]),
                    "score": best[1],
                    "system_text": attempt_row["system_text"],
                    "user_template": attempt_row["user_template"],
                },
            )

    # Per-turn summary.
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT score FROM swarm_attempts
            WHERE run_id = %s AND turn = %s AND score IS NOT NULL
            ORDER BY agent_idx
            """,
            (run_id, turn),
        )
        scores = [float(r["score"]) for r in cur.fetchall()]
        cur.execute(
            "SELECT best_attempt_id, best_score FROM swarm_runs WHERE id = %s",
            (run_id,),
        )
        best_row = cur.fetchone()

    mean = sum(scores) / len(scores) if scores else 0.0
    mx = max(scores) if scores else 0.0
    logger.info(
        "turn_complete run=%s turn=%s n=%d mean=%.3f max=%.3f best=%s elapsed_ms=%d",
        run_id, turn, len(scores), mean, mx,
        f"{best_row['best_score']:.3f}" if best_row and best_row["best_score"] is not None else "—",
        int((time.monotonic() - turn_started) * 1000),
    )
    await broker.publish(
        run_id,
        {
            "type": "turn_complete",
            "turn": turn,
            "scores": scores,
            "best_attempt_id": str(best_row["best_attempt_id"]) if best_row and best_row["best_attempt_id"] else None,
            "best_score": float(best_row["best_score"]) if best_row and best_row["best_score"] is not None else None,
        },
    )


async def _run_loop(run_id: UUID) -> None:
    """Top-level loop. Exits when the run's status flips out of 'running'."""
    client = anthropic.AsyncAnthropic()
    loop_started = time.monotonic()
    turns_run = 0
    logger.info("run_loop start run=%s", run_id)
    try:
        project_id, cfg, current_turn = _load_run(run_id)
        datasets, json_schema = _load_project_assets(project_id)
        logger.info(
            "run_loop loaded run=%s project=%s cfg=%s starting_turn=%d datasets=%d",
            run_id, project_id, cfg, current_turn + 1, len(datasets),
        )
        while _get_run_status(run_id) == "running":
            pool = _load_pool(run_id)
            current_turn += 1
            try:
                await _run_one_turn(
                    client, run_id, current_turn, cfg, pool, datasets, json_schema
                )
                turns_run += 1
            except Exception as e:  # noqa: BLE001
                logger.exception(
                    "run_loop turn_failed run=%s turn=%s err=%s",
                    run_id, current_turn, e,
                )
                _set_run_status(run_id, "failed", str(e))
                await broker.publish(run_id, {"type": "error", "message": str(e)})
                return
            # Polite yield to let pause requests be observed.
            await asyncio.sleep(0)
        # Either paused or stopped externally.
        final_status = _get_run_status(run_id)
        logger.info(
            "run_loop exit run=%s final_status=%s turns_run=%d elapsed_s=%.1f",
            run_id, final_status, turns_run,
            time.monotonic() - loop_started,
        )
        if final_status == "paused":
            await broker.publish(run_id, {"type": "paused"})
        elif final_status == "completed":
            await broker.publish(run_id, {"type": "completed"})
    finally:
        _running_tasks.pop(run_id, None)


def start_run(run_id: UUID) -> bool:
    """Start (or resume) a run. Idempotent — returns False if already running."""
    if is_running(run_id):
        logger.info("start_run skip run=%s (already running)", run_id)
        return False
    status = _get_run_status(run_id)
    if status not in ("idle", "paused", "failed"):
        logger.info("start_run skip run=%s (status=%s not startable)", run_id, status)
        return False
    logger.info("start_run run=%s prev_status=%s", run_id, status)
    _set_run_status(run_id, "running", None)
    task = asyncio.create_task(_run_loop(run_id))
    _running_tasks[run_id] = task
    return True


async def request_pause(run_id: UUID) -> None:
    """Flip status to paused; the loop observes between turns and exits."""
    logger.info("pause_requested run=%s", run_id)
    _set_run_status(run_id, "paused")
    # The running task will publish 'paused' itself when it observes the change.


# --------------------------------------------------------------------------- #
# Snapshot for /stream initial frame
# --------------------------------------------------------------------------- #


def snapshot(run_id: UUID) -> dict[str, Any]:
    """Build a `snapshot` event payload (run + all attempts + best)."""
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, project_id, config, status, current_turn,
                   best_attempt_id, best_score, error, created_at
            FROM swarm_runs WHERE id = %s
            """,
            (run_id,),
        )
        run_row = cur.fetchone()
        if run_row is None:
            return {"type": "error", "message": "run not found"}
        cur.execute(
            """
            SELECT id, turn, agent_idx, parent_attempt_id, status,
                   system_text, user_template, score, pheromone,
                   x, y, error
            FROM swarm_attempts
            WHERE run_id = %s
            ORDER BY turn, agent_idx
            """,
            (run_id,),
        )
        attempts = cur.fetchall()
        best = None
        if run_row["best_attempt_id"]:
            cur.execute(
                """
                SELECT id, system_text, user_template, score
                FROM swarm_attempts WHERE id = %s
                """,
                (run_row["best_attempt_id"],),
            )
            best = cur.fetchone()
    return {
        "type": "snapshot",
        "run": {
            "id": str(run_row["id"]),
            "project_id": str(run_row["project_id"]),
            "config": run_row["config"],
            "status": run_row["status"],
            "current_turn": run_row["current_turn"],
            "best_attempt_id": str(run_row["best_attempt_id"]) if run_row["best_attempt_id"] else None,
            "best_score": run_row["best_score"],
            "error": run_row["error"],
        },
        "attempts": [
            {
                "id": str(a["id"]),
                "turn": a["turn"],
                "agent_idx": a["agent_idx"],
                "parent_attempt_id": str(a["parent_attempt_id"]) if a["parent_attempt_id"] else None,
                "status": a["status"],
                "system_preview": (a["system_text"] or "")[:200],
                "user_preview": (a["user_template"] or "")[:200],
                "score": a["score"],
                "pheromone": a["pheromone"],
                "x": a["x"],
                "y": a["y"],
                "error": a["error"],
            }
            for a in attempts
        ],
        "best": (
            {
                "id": str(best["id"]),
                "system_text": best["system_text"],
                "user_template": best["user_template"],
                "score": best["score"],
            }
            if best
            else None
        ),
        "ts": time.time(),
    }
