"""Local-dev .env loader.

Loads `.env.local` and `.env` from the project root into os.environ. Existing
env vars win, so this is a no-op on Vercel (where envs are injected upstream).
"""
import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
_FILES = (".env.local", ".env")


def _parse_line(line: str) -> tuple[str, str] | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if line.startswith("export "):
        line = line[len("export ") :].lstrip()
    if "=" not in line:
        return None
    key, _, value = line.partition("=")
    key = key.strip()
    value = value.strip()
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        value = value[1:-1]
    return key, value


def load_dotenv() -> None:
    for name in _FILES:
        path = _ROOT / name
        if not path.is_file():
            continue
        for raw in path.read_text().splitlines():
            parsed = _parse_line(raw)
            if not parsed:
                continue
            key, value = parsed
            os.environ.setdefault(key, value)
