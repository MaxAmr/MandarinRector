"""Columnas de segmentación jieba y pinyin en subtitletrack.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-17 15:46:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel.sql.sqltypes

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "subtitletrack",
        sa.Column("script", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    )
    op.add_column(
        "subtitletrack",
        sa.Column(
            "tokens_status",
            sqlmodel.sql.sqltypes.AutoString(),
            server_default="not_applicable",
            nullable=False,
        ),
    )
    op.add_column(
        "subtitletrack",
        sa.Column("tokens_version", sa.Integer(), nullable=True),
    )
    op.add_column(
        "subtitletrack",
        sa.Column("tokens_error", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    )
    op.add_column(
        "subtitletrack",
        sa.Column("tokens_updated_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("subtitletrack", "tokens_updated_at")
    op.drop_column("subtitletrack", "tokens_error")
    op.drop_column("subtitletrack", "tokens_version")
    op.drop_column("subtitletrack", "tokens_status")
    op.drop_column("subtitletrack", "script")
