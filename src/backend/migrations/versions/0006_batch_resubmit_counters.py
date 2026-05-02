"""generation_jobs batch resubmit counters

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-02

Bound the dataset/run batch resubmit loop to prevent credit drain when
some items consistently fail.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE generation_jobs
            ADD COLUMN dataset_attempts int NOT NULL DEFAULT 0,
            ADD COLUMN run_attempts int NOT NULL DEFAULT 0
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE generation_jobs
            DROP COLUMN IF EXISTS dataset_attempts,
            DROP COLUMN IF EXISTS run_attempts
        """
    )
