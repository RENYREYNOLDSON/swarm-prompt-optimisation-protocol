"""generation_jobs batch IDs + drop unused columns

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-02

The runner is moving from in-process asyncio to stateless `advance()`. With
that change we no longer need:
  - `lease_owner` / `lease_expires_at`  (advisory lock instead)
  - `schema_obj`                         (schema lives in memory between
                                          writing_schema and writing_prompt
                                          steps; or persisted ad-hoc if needed)

We add:
  - `dataset_batch_id`, `run_batch_id`   (Anthropic Batch handles)

The set of valid `status` values is enforced in app code (no CHECK constraint
to avoid migration headaches when adding states).
"""
from typing import Sequence, Union

from alembic import op


revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE generation_jobs
            ADD COLUMN dataset_batch_id text,
            ADD COLUMN run_batch_id text
        """
    )
    op.execute(
        "ALTER TABLE generation_jobs DROP COLUMN IF EXISTS lease_owner"
    )
    op.execute(
        "ALTER TABLE generation_jobs DROP COLUMN IF EXISTS lease_expires_at"
    )
    op.execute(
        "ALTER TABLE generation_jobs DROP COLUMN IF EXISTS schema_obj"
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE generation_jobs
            DROP COLUMN IF EXISTS dataset_batch_id,
            DROP COLUMN IF EXISTS run_batch_id,
            ADD COLUMN lease_owner text,
            ADD COLUMN lease_expires_at timestamptz,
            ADD COLUMN schema_obj jsonb
        """
    )
