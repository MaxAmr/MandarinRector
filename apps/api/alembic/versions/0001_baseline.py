"""Esquema base de Fases 1 y 2 (video, subtitletrack, cue).

Revision ID: 0001
Revises: None
Create Date: 2026-11-17 15:45:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel.sql.sqltypes

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "video",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("title", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("original_filename", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("original_path", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("playback_path", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("thumbnail_path", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("duration", sa.Float(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("video_codec", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("audio_codec", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("container", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("PROCESSING", "READY", "ERROR", name="videostatus"),
            nullable=False,
        ),
        sa.Column("error_message", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_video_created_at"), "video", ["created_at"], unique=False)
    op.create_index(op.f("ix_video_status"), "video", ["status"], unique=False)
    op.create_index(op.f("ix_video_title"), "video", ["title"], unique=False)

    op.create_table(
        "subtitletrack",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("video_id", sa.Integer(), nullable=False),
        sa.Column("lang", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("label", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("is_primary", sa.Boolean(), nullable=False),
        sa.Column("source_format", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("original_filename", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("detected_encoding", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("cue_count", sa.Integer(), nullable=False),
        sa.Column("offset_ms", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["video_id"], ["video.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_subtitletrack_video_id"),
        "subtitletrack",
        ["video_id"],
        unique=False,
    )

    op.create_table(
        "cue",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("track_id", sa.Integer(), nullable=False),
        sa.Column("idx", sa.Integer(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("text", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("tokens_json", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.ForeignKeyConstraint(
            ["track_id"], ["subtitletrack.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("track_id", "idx", name="uq_cue_track_id_idx"),
    )
    op.create_index(
        "ix_cue_track_id_start_ms",
        "cue",
        ["track_id", "start_ms"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_cue_track_id_start_ms", table_name="cue")
    op.drop_table("cue")
    op.drop_index(op.f("ix_subtitletrack_video_id"), table_name="subtitletrack")
    op.drop_table("subtitletrack")
    op.drop_index(op.f("ix_video_title"), table_name="video")
    op.drop_index(op.f("ix_video_status"), table_name="video")
    op.drop_index(op.f("ix_video_created_at"), table_name="video")
    op.drop_table("video")
