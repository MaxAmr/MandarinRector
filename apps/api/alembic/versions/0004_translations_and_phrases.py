"""Emparejado de traducción en cue, tabla translationcache y tabla phrase (Fases 5 y 6).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-17 17:44:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel.sql.sqltypes

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "cue",
        sa.Column("translation_text", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    )

    op.create_table(
        "translationcache",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source_text", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("target_lang", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("translated_text", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("provider", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_text",
            "target_lang",
            name="uq_translationcache_source_lang",
        ),
    )
    op.create_index(
        op.f("ix_translationcache_source_text"),
        "translationcache",
        ["source_text"],
        unique=False,
    )

    op.create_table(
        "phrase",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("video_id", sa.Integer(), nullable=False),
        sa.Column("track_id", sa.Integer(), nullable=True),
        sa.Column("cue_idx", sa.Integer(), nullable=True),
        sa.Column("hanzi", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("focus_word", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("pinyin", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("translation", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("notes", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column(
            "clip_status",
            sqlmodel.sql.sqltypes.AutoString(),
            server_default="pending",
            nullable=False,
        ),
        sa.Column("clip_video_path", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("clip_audio_path", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("clip_thumb_path", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("clip_error", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["video_id"], ["video.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["track_id"], ["subtitletrack.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_phrase_created_at"),
        "phrase",
        ["created_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_phrase_video_id"),
        "phrase",
        ["video_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_phrase_video_id"), table_name="phrase")
    op.drop_index(op.f("ix_phrase_created_at"), table_name="phrase")
    op.drop_table("phrase")
    op.drop_index(
        op.f("ix_translationcache_source_text"),
        table_name="translationcache",
    )
    op.drop_table("translationcache")
    op.drop_column("cue", "translation_text")
