"""Tabla dictionaryentry para CC-CEDICT (Fase 4).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-17 17:08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel.sql.sqltypes

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "dictionaryentry",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("traditional", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("simplified", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("pinyin_numeric", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("pinyin_marks", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("definitions_json", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("classifiers_json", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("rank", sa.Integer(), nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_dictionaryentry_simplified"),
        "dictionaryentry",
        ["simplified"],
        unique=False,
    )
    op.create_index(
        op.f("ix_dictionaryentry_traditional"),
        "dictionaryentry",
        ["traditional"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_dictionaryentry_traditional"), table_name="dictionaryentry")
    op.drop_index(op.f("ix_dictionaryentry_simplified"), table_name="dictionaryentry")
    op.drop_table("dictionaryentry")
