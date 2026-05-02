"""add difficulty to projects

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-02

"""
from typing import Sequence, Union

from alembic import op


revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE projects
        ADD COLUMN difficulty int NOT NULL DEFAULT 5
            CHECK (difficulty BETWEEN 1 AND 10)
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE projects DROP COLUMN difficulty")
