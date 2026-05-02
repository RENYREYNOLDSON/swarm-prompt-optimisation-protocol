"""In-process pub/sub for swarm-run events.

Single-worker assumption (matches the existing `/generate` streaming
endpoint). Multiple browser tabs can subscribe to the same run and the
orchestrator outlives any single HTTP request — events are routed through
this broker.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any
from uuid import UUID

logger = logging.getLogger("spop.broker")


class SwarmBroker:
    def __init__(self) -> None:
        self._subs: dict[UUID, set[asyncio.Queue[dict[str, Any] | None]]] = {}

    def subscribe(self, run_id: UUID) -> asyncio.Queue[dict[str, Any] | None]:
        q: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=1024)
        self._subs.setdefault(run_id, set()).add(q)
        logger.info(
            "subscribe run=%s subs_now=%d", run_id, len(self._subs[run_id])
        )
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
        remaining = len(subs)
        if not subs:
            self._subs.pop(run_id, None)
        logger.info("unsubscribe run=%s subs_now=%d", run_id, remaining)

    async def publish(self, run_id: UUID, event: dict[str, Any]) -> None:
        subs = self._subs.get(run_id, set())
        dropped = 0
        for q in list(subs):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Drop slow consumers rather than back-pressure the orchestrator.
                dropped += 1
        logger.debug(
            "publish run=%s type=%s subs=%d dropped=%d",
            run_id, event.get("type", "?"), len(subs), dropped,
        )
        if dropped:
            logger.warning(
                "publish dropped event for slow consumer run=%s type=%s dropped=%d",
                run_id, event.get("type", "?"), dropped,
            )

    def close(self, run_id: UUID) -> None:
        """Send a sentinel `None` to all subscribers and drop them."""
        for q in list(self._subs.get(run_id, set())):
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self._subs.pop(run_id, None)
        logger.info("close run=%s", run_id)


broker = SwarmBroker()
