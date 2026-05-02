import os
from contextlib import contextmanager
from typing import Iterator

from fastapi import HTTPException
from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

_pool: ConnectionPool | None = None


def _check_conn(conn: Connection) -> None:
    """Cheap liveness check — pool runs this before handing a conn out so a
    socket Neon's pooler closed silently doesn't escape into a request."""
    conn.execute("SELECT 1")


def _get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise HTTPException(
                status_code=503,
                detail="DATABASE_URL is not configured on the backend.",
            )
        _pool = ConnectionPool(
            conninfo=url,
            min_size=0,
            max_size=10,
            max_idle=300,  # recycle anything sitting idle > 5 min
            kwargs={"row_factory": dict_row, "autocommit": False},
            check=_check_conn,
            open=True,
        )
    return _pool


@contextmanager
def connection() -> Iterator[Connection]:
    pool = _get_pool()
    with pool.connection() as conn:
        yield conn


def db_conn() -> Iterator[Connection]:
    with connection() as conn:
        yield conn
