import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# Load env from project root .env.local (so DATABASE_URL is available).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.env import load_dotenv  # noqa: E402

load_dotenv()

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
if not url:
    raise RuntimeError(
        "DATABASE_URL_UNPOOLED or DATABASE_URL must be set "
        "(checked .env.local and process env)."
    )
# Force SQLAlchemy onto psycopg v3 (we don't install psycopg2).
if url.startswith("postgresql://"):
    url = "postgresql+psycopg://" + url[len("postgresql://") :]
elif url.startswith("postgres://"):
    url = "postgresql+psycopg://" + url[len("postgres://") :]
config.set_main_option("sqlalchemy.url", url)

target_metadata = None  # raw-SQL migrations; no SQLAlchemy models


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
