"""generation_jobs as a resumable state machine

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-02

Drops the speculative generation_jobs schema and rebuilds it as a
state-machine row: one active job per project, persisted progress per
step, lease-based dedupe so the runner survives client refresh.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS generation_jobs")

    op.execute(
        """
        CREATE TABLE generation_jobs (
            id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

            status              text NOT NULL DEFAULT 'queued',
                -- queued | planning | submitting_datasets | awaiting_datasets
                -- | writing_prompt | submitting_runs | awaiting_runs
                -- | completed | failed | cancelled
                -- (with the in-process runner we mostly use queued/planning/
                -- generating_datasets/writing_prompt/generating_runs/completed.)

            -- Plan
            archetype           text,
            instances           jsonb,                -- list[str]

            -- Step outputs
            schema_obj          jsonb,                -- transient: GeneratedSchema
            prompt_id           uuid REFERENCES prompts(id) ON DELETE SET NULL,

            -- Step counters (for fine-grained progress)
            datasets_done       int NOT NULL DEFAULT 0,
            runs_done           int NOT NULL DEFAULT 0,

            -- Lease (so two processes / tabs don't run the same job)
            lease_owner         text,
            lease_expires_at    timestamptz,

            -- Errors
            error               text,
            error_step          text,

            -- Timestamps
            started_at          timestamptz NOT NULL DEFAULT now(),
            updated_at          timestamptz NOT NULL DEFAULT now(),
            completed_at        timestamptz
        )
        """
    )
    op.execute(
        "CREATE INDEX generation_jobs_project_idx "
        "ON generation_jobs (project_id, started_at DESC)"
    )
    # At most one *active* job per project. Failed/completed/cancelled jobs
    # stay for history and don't conflict with a fresh active one.
    op.execute(
        "CREATE UNIQUE INDEX generation_jobs_active_uq "
        "ON generation_jobs (project_id) "
        "WHERE status NOT IN ('completed', 'failed', 'cancelled')"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS generation_jobs")
    # Recreate the original placeholder shape (from 0001) so down/up cycles work.
    op.execute(
        """
        CREATE TABLE generation_jobs (
            id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            kind          text NOT NULL,
            step_idx      int,
            status        text NOT NULL DEFAULT 'queued',
            error         text,
            started_at    timestamptz,
            finished_at   timestamptz,
            created_at    timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX generation_jobs_project_idx "
        "ON generation_jobs (project_id, created_at)"
    )
