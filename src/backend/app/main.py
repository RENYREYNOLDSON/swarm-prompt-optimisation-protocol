from pathlib import Path

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

app = FastAPI(title="SPOP API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    app.mount("/", StaticFiles(directory=_frontend_dist, html=True), name="frontend")
