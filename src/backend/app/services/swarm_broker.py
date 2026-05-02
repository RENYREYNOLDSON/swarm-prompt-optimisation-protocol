"""In-process pub/sub for swarm-run events.

Single-worker assumption (matches the existing `/generate` streaming
endpoint). Multiple browser tabs can subscribe to the same run and the
orchestrator outlives any single HTTP request — events are routed through
this broker.
"""
from __future__ import annotations

import asyncio
from typing import Any
from uuid import UUID


class SwarmBroker:
    def __init__(self) -> None:
        self._subs: dict[UUID, set[asyncio.Queue[dict[str, Any] | None]]] = {}

    def subscribe(self, run_id: UUID) -> asyncio.Queue[dict[str, Any] | None]:
        q: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=1024)
        self._subs.setdefault(run_id, set()).add(q)
        return q

    def unsubscribe(
        self,
        run_id: UUID,
        queue: asyncio.Queue[dict[str, Any] | None],
    ) -> None:
        subs = self._subs.get(run_id)
        if not subs:
            return
        subs.discard(queue)
        if not subs:
            self._subs.pop(run_id, None)

    async def publish(self, run_id: UUID, event: dict[str, Any]) -> None:
        for q in list(self._subs.get(run_id, set())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Drop slow consumers rather than back-pressure the orchestrator.
                pass

    def close(self, run_id: UUID) -> None:
        """Send a sentinel `None` to all subscribers and drop them."""
        for q in list(self._subs.get(run_id, set())):
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self._subs.pop(run_id, None)


broker = SwarmBroker()
