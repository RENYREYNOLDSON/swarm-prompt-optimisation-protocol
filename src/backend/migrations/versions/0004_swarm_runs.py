"""swarm runs and attempts

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-02

"""
from typing import Sequence, Union

from alembic import op


revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE swarm_runs (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            config          jsonb NOT NULL,
            status          text NOT NULL DEFAULT 'idle',
            current_turn    int  NOT NULL DEFAULT 0,
            best_attempt_id uuid,
            best_score      double precision,
            error           text,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            CHECK (status IN ('idle','running','paused','completed','failed'))
        )
        """
    )
    op.execute(
        "CREATE INDEX swarm_runs_project_idx ON swarm_runs (project_id, created_at DESC)"
    )

    op.execute(
        """
        CREATE TABLE swarm_attempts (
            id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            run_id               uuid NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
            turn                 int  NOT NULL,
            agent_idx            int  NOT NULL,
            parent_attempt_id    uuid REFERENCES swarm_attempts(id) ON DELETE SET NULL,
            status               text NOT NULL DEFAULT 'pending',
            system_text          text,
            user_template        text,
            training_dataset_ids uuid[],
            test_dataset_id      uuid,
            predicted_output     jsonb,
            score                double precision,
            pheromone            double precision NOT NULL DEFAULT 0,
            embedding            double precision[],
            x                    double precision,
            y                    double precision,
            error                text,
            started_at           timestamptz NOT NULL DEFAULT now(),
            finished_at          timestamptz,
            UNIQUE (run_id, turn, agent_idx),
            CHECK (status IN ('pending','sampling','drafting','scoring','done','failed'))
        )
        """
    )
    op.execute(
        "CREATE INDEX swarm_attempts_pool_idx ON swarm_attempts (run_id, pheromone DESC)"
    )
    op.execute(
        "CREATE INDEX swarm_attempts_run_turn_idx ON swarm_attempts (run_id, turn)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS swarm_attempts")
    op.execute("DROP TABLE IF EXISTS swarm_runs")
