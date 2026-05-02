import os
from pathlib import Path

from app.env import load_dotenv

load_dotenv()

import anthropic  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from app.routers import chat, generation, projects, swarm  # noqa: E402

app = FastAPI(title="SPOP API", version="0.1.0")


def _allowed_origins() -> list[str]:
    raw = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173")
    return [o.strip() for o in raw.split(",") if o.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["authorization", "content-type"],
)

app.include_router(projects.router)
app.include_router(generation.router)
app.include_router(generation.cron_router)
app.include_router(chat.router)
app.include_router(swarm.router)


class StructuredPrompt(BaseModel):
    role: str = Field(description="Persona/role the model should adopt.")
    objective: str = Field(description="Single-sentence statement of the task goal.")
    instructions: list[str] = Field(description="Ordered, atomic instructions the model must follow.")
    constraints: list[str] = Field(description="Hard requirements and things to avoid.")
    output_format: str = Field(description="Exact format the response should take.")
    examples: list[str] = Field(default_factory=list, description="Optional few-shot examples.")


class OptimiseRequest(BaseModel):
    context: str
    output: str
    model: str = "claude-opus-4-7"


class OptimiseResponse(BaseModel):
    prompt: StructuredPrompt


def generate_structured_prompt(
    context: str,
    desired_output: str,
    model: str,
) -> StructuredPrompt:
    client = anthropic.Anthropic()

    system = (
        "You are a prompt optimisation expert. Given a user's context and the "
        "output they want, produce a structured prompt that, when executed by an "
        "LLM, reliably yields that output."
    )
    user = (
        f"<context>\n{context}\n</context>\n\n"
        f"<desired_output>\n{desired_output}\n</desired_output>\n\n"
        "Produce the structured prompt."
    )

    response = client.messages.parse(
        model=model,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=StructuredPrompt,
    )
    return response.parsed_output


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/optimise", response_model=OptimiseResponse)
def optimise(req: OptimiseRequest) -> OptimiseResponse:
    try:
        prompt = generate_structured_prompt(req.context, req.output, req.model)
    except anthropic.NotFoundError as e:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.model}") from e
    except anthropic.AuthenticationError as e:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY missing or invalid") from e
    except anthropic.APIStatusError as e:
        raise HTTPException(status_code=502, detail=f"Upstream error: {e.message}") from e
    return OptimiseResponse(prompt=prompt)


_frontend_dist = Path(__file__).resolve().parents[3] / "src" / "frontend" / "dist"
if _frontend_dist.is_dir():
    _dist_root = _frontend_dist.resolve()
    _index_html = _dist_root / "index.html"

    @app.get("/{full_path:path}")
    async def spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        if full_path:
            candidate = (_dist_root / full_path).resolve()
            try:
                candidate.relative_to(_dist_root)
            except ValueError:
                raise HTTPException(status_code=404) from None
            if candidate.is_file():
                return FileResponse(candidate)
        return FileResponse(_index_html)
