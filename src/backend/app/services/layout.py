"""Embed prompts and project to 2D for the swarm map.

Strategy:
  1. Embed `system_text + "\n\n" + user_template` with Voyage AI
     (`voyage-3-lite`, 1024-dim) when `VOYAGE_API_KEY` is set.
  2. Otherwise fall back to a deterministic local hash-vectoriser
     (no extra network/API key needed).
  3. Project to 2D with PCA fit on all embeddings in this run so far.
     PCA is deterministic and stable, so new points land in coords
     consistent with the existing layout — no jumpy animation.
  4. Coordinates are normalised to [-1, 1] per axis (per the run).
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from typing import Any

import numpy as np
from sklearn.decomposition import PCA

logger = logging.getLogger("spop.layout")

EMBED_DIM_FALLBACK = 256
EMBED_MODEL = "voyage-3-lite"


# --------------------------------------------------------------------------- #
# Embedding
# --------------------------------------------------------------------------- #


_voyage_client = None


def _get_voyage_client():
    """Lazy import so installs without voyageai still work."""
    global _voyage_client
    if _voyage_client is not None:
        return _voyage_client
    if not os.environ.get("VOYAGE_API_KEY"):
        logger.debug("voyage embeddings disabled (no VOYAGE_API_KEY) — using hash fallback")
        return None
    try:
        import voyageai  # type: ignore[import-not-found]
    except ImportError:
        logger.warning("voyageai package not installed — using hash fallback")
        return None
    _voyage_client = voyageai.AsyncClient()
    logger.info("voyage embeddings enabled (model=%s)", EMBED_MODEL)
    return _voyage_client


def _hash_embed(text: str, dim: int = EMBED_DIM_FALLBACK) -> list[float]:
    """Deterministic hashing-trick embedding. Token-frequency vector hashed
    into `dim` buckets, then L2-normalised. Good enough for clustering."""
    import re

    vec = np.zeros(dim, dtype=np.float64)
    for tok in re.findall(r"[a-zA-Z0-9]+", text.lower()):
        h = hashlib.blake2b(tok.encode("utf-8"), digest_size=8).digest()
        idx = int.from_bytes(h[:4], "little") % dim
        sign = 1.0 if (h[4] & 1) == 0 else -1.0
        vec[idx] += sign
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec /= norm
    return vec.tolist()


async def embed_prompt(system_text: str, user_template: str) -> list[float]:
    """Return an embedding for the (system, user) prompt pair."""
    text = f"{system_text}\n\n{user_template}".strip()
    if not text:
        return _hash_embed("")
    client = _get_voyage_client()
    if client is not None:
        try:
            result = await client.embed(
                texts=[text], model=EMBED_MODEL, input_type="document"
            )
            return list(result.embeddings[0])
        except Exception as e:
            # Fall back silently — the swarm shouldn't fail on embed errors —
            # but at least surface the cause so we can debug rate limits etc.
            logger.warning("voyage embed failed (%s) — using hash fallback", e)
    # Hash-trick fallback (or thread-pool isn't needed; it's pure Python).
    return await asyncio.to_thread(_hash_embed, text)


# --------------------------------------------------------------------------- #
# Projection
# --------------------------------------------------------------------------- #


def project_pca_2d(embeddings: list[list[float]]) -> list[tuple[float, float]]:
    """Project an N×D embedding matrix to N×2 with PCA.

    Coordinates are normalised so each axis spans [-1, 1] over the run.
    Returns coords in the same order as the input."""
    if not embeddings:
        return []
    arr = np.asarray(embeddings, dtype=np.float64)
    n = arr.shape[0]
    if n == 1:
        return [(0.0, 0.0)]
    if n == 2:
        # PCA needs at least 2 components; use a simple 1-D layout.
        diff = arr[1] - arr[0]
        scale = float(np.linalg.norm(diff)) or 1.0
        return [(-1.0, 0.0), (1.0, 0.0)] if scale else [(0.0, 0.0), (0.0, 0.0)]
    n_components = min(2, arr.shape[1])
    pca = PCA(n_components=n_components, svd_solver="auto")
    coords = pca.fit_transform(arr)
    if coords.shape[1] == 1:
        coords = np.hstack([coords, np.zeros((n, 1))])
    # Normalise per-axis to [-1, 1].
    for axis in range(2):
        col = coords[:, axis]
        lo, hi = float(col.min()), float(col.max())
        span = hi - lo
        if span > 0:
            coords[:, axis] = 2.0 * (col - lo) / span - 1.0
        else:
            coords[:, axis] = 0.0
    return [(float(x), float(y)) for x, y in coords]
