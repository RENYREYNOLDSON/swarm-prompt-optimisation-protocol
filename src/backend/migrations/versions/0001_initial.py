"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-05-02

"""
from typing import Sequence, Union

from alembic import op


revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')

    op.execute(
        """
        CREATE TABLE projects (
            id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id       text NOT NULL,
            name          text NOT NULL,
            domain        text NOT NULL,
            status        text NOT NULL DEFAULT 'pending',
            created_at    timestamptz NOT NULL DEFAULT now(),
            updated_at    timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX projects_user_id_idx ON projects (user_id, created_at DESC)")

    op.execute(
        """
        CREATE TABLE datasets (
            id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            idx           int NOT NULL,
            title         text NOT NULL,
            content       text NOT NULL,
            token_count   int,
            created_at    timestamptz NOT NULL DEFAULT now(),
            UNIQUE (project_id, idx)
        )
        """
    )

    op.execute(
        """
        CREATE TABLE prompts (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            version         int NOT NULL,
            system_text     text NOT NULL,
            user_template   text NOT NULL,
            output_schema   jsonb NOT NULL,
            notes           text,
            created_at      timestamptz NOT NULL DEFAULT now(),
            UNIQUE (project_id, version)
        )
        """
    )

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
    op.execute("CREATE INDEX generation_jobs_project_idx ON generation_jobs (project_id, created_at)")

    op.execute(
        """
        CREATE TABLE runs (
            id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            prompt_id           uuid NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
            dataset_id          uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            model               text NOT NULL,
            structured_output   jsonb,
            tokens_in           int,
            tokens_out          int,
            latency_ms          int,
            error               text,
            created_at          timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX runs_project_idx ON runs (project_id, created_at DESC)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS runs")
    op.execute("DROP TABLE IF EXISTS generation_jobs")
    op.execute("DROP TABLE IF EXISTS prompts")
    op.execute("DROP TABLE IF EXISTS datasets")
    op.execute("DROP TABLE IF EXISTS projects")
