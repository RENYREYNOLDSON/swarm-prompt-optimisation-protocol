"""Project-scoped SPOP chat. Stateless: client sends full message history,
server loads project context, streams the assistant response."""
import json
from typing import Any, Literal
from uuid import UUID

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from psycopg import Connection
from pydantic import BaseModel, Field

from app.auth import CurrentUser
from app.db import db_conn

router = APIRouter(prefix="/api/projects", tags=["chat"])

CHAT_MODEL = "claude-opus-4-7"

SPOP_SYSTEM = """You are SPOP — Swarm Prompt Optimisation Protocol.

You help the user understand and iterate on a structured-extraction project: \
sample documents in their domain, the JSON Schema we extract into, and the \
prompt that drives that extraction.

Tone:
- Direct, technical, opinionated.
- No sycophantic preambles ("Great question!").
- Short answers when short answers suffice.

You are aware of the user's project; the relevant context is provided below."""


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)


def _ensure_owner(conn: Connection, project_id: UUID, user_id: str) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, domain, status FROM projects WHERE id = %s AND user_id = %s",
            (project_id, user_id),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return row


def _project_context(conn: Connection, project_id: UUID) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT idx, title, char_length(content) AS chars
            FROM datasets WHERE project_id = %s ORDER BY idx
            """,
            (project_id,),
        )
        datasets = cur.fetchall()
        cur.execute(
            """
            SELECT version, system_text, user_template, output_schema, notes
            FROM prompts WHERE project_id = %s ORDER BY version DESC LIMIT 1
            """,
            (project_id,),
        )
        prompt = cur.fetchone()

    parts = []
    if datasets:
        lines = "\n".join(
            f"  {r['idx']:>2}. {r['title']} ({r['chars']:,} chars)" for r in datasets
        )
        parts.append(f"<datasets count=\"{len(datasets)}\">\n{lines}\n</datasets>")
    else:
        parts.append("<datasets>none yet</datasets>")

    if prompt:
        schema_summary = json.dumps(prompt["output_schema"], indent=2)[:4000]
        parts.append(
            "<prompt version=\"{v}\">\n"
            "<system_text>\n{sys}\n</system_text>\n"
            "<user_template>\n{ut}\n</user_template>\n"
            "<output_schema>\n{schema}\n</output_schema>\n"
            "<notes>{notes}</notes>\n"
            "</prompt>".format(
                v=prompt["version"],
                sys=prompt["system_text"],
                ut=prompt["user_template"],
                schema=schema_summary,
                notes=prompt["notes"] or "",
            )
        )
    else:
        parts.append("<prompt>none yet</prompt>")
    return "\n\n".join(parts)


@router.post("/{project_id}/chat")
async def chat(
    project_id: UUID,
    body: ChatRequest,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> StreamingResponse:
    project = _ensure_owner(conn, project_id, user_id)
    context = _project_context(conn, project_id)

    system = (
        f"{SPOP_SYSTEM}\n\n"
        f"<project>\n"
        f"  <name>{project['name']}</name>\n"
        f"  <domain>{project['domain']}</domain>\n"
        f"  <status>{project['status']}</status>\n"
        f"</project>\n\n"
        f"{context}"
    )

    client = anthropic.AsyncAnthropic()

    async def stream():
        try:
            async with client.messages.stream(
                model=CHAT_MODEL,
                max_tokens=4096,
                system=system,
                messages=[m.model_dump() for m in body.messages],
            ) as s:
                async for delta in s.text_stream:
                    yield delta.encode("utf-8")
        except anthropic.APIStatusError as e:
            yield f"\n\n[upstream error: {e.message}]".encode("utf-8")
        except Exception as e:  # noqa: BLE001
            yield f"\n\n[error: {e}]".encode("utf-8")

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")
