import base64
import os
import ssl
import time
from typing import Annotated

import certifi
import httpx
import jwt
from fastapi import Depends, HTTPException, Request, status
from jwt import PyJWKClient

_JWKS_TTL_SECONDS = 3600

# Order matters: prefer the explicit Clerk-named vars, fall back to the
# project's NEXT_PUBLIC_* var (which is already set in .env.local).
_PUBLISHABLE_KEY_VARS = (
    "CLERK_PUBLISHABLE_KEY",
    "VITE_CLERK_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SWARM_AUTH_CLERK_PUBLISHABLE_KEY",
)

_jwks_client: PyJWKClient | None = None
_jwks_loaded_at: float = 0.0


def _frontend_api_from_publishable_key(pk: str) -> str:
    """Decode the Clerk Frontend API host from a publishable key.

    Clerk publishable keys look like `pk_(test|live)_<base64>` where the
    base64 portion (URL-safe, optional `$` terminator) decodes to the
    Frontend API host (e.g. `clean-platypus-12.clerk.accounts.dev`).
    """
    parts = pk.split("_", 2)
    if len(parts) != 3 or parts[0] != "pk" or parts[1] not in ("test", "live"):
        raise ValueError("Not a recognised Clerk publishable key.")
    encoded = parts[2]
    padded = encoded + "=" * (-len(encoded) % 4)
    decoded = base64.urlsafe_b64decode(padded).decode("ascii").rstrip("$").rstrip("/")
    if not decoded:
        raise ValueError("Empty Frontend API host decoded from publishable key.")
    return decoded


def _resolve_clerk_urls() -> tuple[str, str]:
    """Resolve (issuer, jwks_url). Explicit env wins; otherwise derive from PK."""
    issuer = os.environ.get("CLERK_JWT_ISSUER")
    jwks_url = os.environ.get("CLERK_JWKS_URL")

    if not (issuer and jwks_url):
        for var in _PUBLISHABLE_KEY_VARS:
            pk = os.environ.get(var)
            if not pk:
                continue
            try:
                host = _frontend_api_from_publishable_key(pk)
            except ValueError:
                continue
            issuer = issuer or f"https://{host}"
            jwks_url = jwks_url or f"https://{host}/.well-known/jwks.json"
            break

    if not issuer or not jwks_url:
        raise HTTPException(
            status_code=503,
            detail=(
                "Clerk auth is not configured. Set CLERK_PUBLISHABLE_KEY "
                "(or CLERK_JWT_ISSUER + CLERK_JWKS_URL) on the backend."
            ),
        )
    return issuer, jwks_url


def _jwks() -> PyJWKClient:
    global _jwks_client, _jwks_loaded_at
    now = time.time()
    if _jwks_client is None or (now - _jwks_loaded_at) > _JWKS_TTL_SECONDS:
        _, jwks_url = _resolve_clerk_urls()
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        _jwks_client = PyJWKClient(jwks_url, cache_keys=True, ssl_context=ssl_context)
        _jwks_loaded_at = now
    return _jwks_client


def _verify_token(token: str) -> dict:
    issuer, _ = _resolve_clerk_urls()
    try:
        signing_key = _jwks().get_signing_key_from_jwt(token).key
        return jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            issuer=issuer,
            options={"require": ["exp", "sub", "iss"]},
        )
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {e}",
        ) from e
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth service unreachable",
        ) from e


def current_user(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    if not header.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
        )
    token = header.split(" ", 1)[1].strip()
    claims = _verify_token(token)
    return claims["sub"]


CurrentUser = Annotated[str, Depends(current_user)]
