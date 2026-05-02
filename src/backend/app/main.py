from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="SPOP API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class OptimiseRequest(BaseModel):
    context: str
    output: str


class OptimiseResponse(BaseModel):
    prompt: str


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/optimise", response_model=OptimiseResponse)
def optimise(req: OptimiseRequest) -> OptimiseResponse:
    return OptimiseResponse(prompt=f"[stub] given context+output, produce: {req.output[:60]}")


_frontend_dist = Path(__file__).resolve().parents[3] / "src" / "frontend" / "dist"
if _frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=_frontend_dist, html=True), name="frontend")
