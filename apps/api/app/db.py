from collections.abc import Generator
import logging
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi import Request
from sqlalchemy import Engine, event, inspect
from sqlmodel import Session, create_engine, select

from app.config import BASE_DIR, Settings, get_settings
from app.models import Video, VideoStatus

logger = logging.getLogger("app.db")


def _configure_sqlite_connection(dbapi_connection: Any, _connection_record: Any) -> None:
    """Configura PRAGMAs en cada conexión SQLite: CASCADE, WAL y busy_timeout."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def build_engine(settings: Settings | None = None) -> Engine:
    active_settings = settings or get_settings()
    active_settings.ensure_directories()
    engine = create_engine(
        active_settings.database_url,
        connect_args={"check_same_thread": False},
    )
    event.listen(engine, "connect", _configure_sqlite_connection)
    return engine


def build_alembic_config(database_url: str | None = None) -> AlembicConfig:
    alembic_ini_path = Path("alembic.ini")
    if not alembic_ini_path.exists():
        alembic_ini_path = Path(BASE_DIR) / "alembic.ini"
    cfg = AlembicConfig(str(alembic_ini_path))
    script_loc = Path("alembic")
    if not script_loc.exists():
        script_loc = Path(BASE_DIR) / "alembic"
    cfg.set_main_option("script_location", str(script_loc))
    cfg.attributes["skip_logging_config"] = True
    if database_url:
        cfg.set_main_option("sqlalchemy.url", database_url)
    return cfg


def init_db(engine: Engine) -> None:
    """Aplica migraciones de Alembic hasta `head` de forma programática."""
    db_url = str(engine.url)
    cfg = build_alembic_config(db_url)

    with engine.begin() as connection:
        inspector = inspect(connection)
        existing_tables = set(inspector.get_table_names())
        cfg.attributes["connection"] = connection

        # Compatibilidad automática con bases de desarrollo creadas con create_all en Fase 1/2
        if "video" in existing_tables and "alembic_version" not in existing_tables:
            sub_cols = {
                col["name"] for col in inspector.get_columns("subtitletrack")
            }
            if "tokens_status" not in sub_cols:
                logger.info(
                    "Base previa de Fase 2 detectada sin tabla alembic_version; aplicando stamp 0001."
                )
                command.stamp(cfg, "0001")

        command.upgrade(cfg, "head")


def recover_interrupted_videos(engine: Engine) -> int:
    """Marca como 'error' los videos que quedaron en 'processing' tras un cierre abrupto previo."""
    with Session(engine) as session:
        statement = select(Video).where(Video.status == VideoStatus.PROCESSING)
        stuck_videos = list(session.exec(statement).all())
        if not stuck_videos:
            return 0
        for video in stuck_videos:
            video.status = VideoStatus.ERROR
            video.error_message = (
                "Procesamiento interrumpido por reinicio del servidor."
            )
            session.add(video)
        session.commit()
        logger.warning(
            "Se marcaron %d video(s) interrumpidos en estado 'error'.",
            len(stuck_videos),
        )
        return len(stuck_videos)


def get_session(request: Request) -> Generator[Session, None, None]:
    """Dependencia FastAPI que entrega una sesión de DB por request."""
    engine: Engine = request.app.state.engine
    with Session(engine) as session:
        yield session
