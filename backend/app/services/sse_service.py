"""
SSE (Server-Sent Events) Service — Redis Pub/Sub bridge.
Real-time Synchronization.

Mechanism:
  - redis.asyncio Pub/Sub listens to 'gantt_updates' channel
  - Each SSE client gets its own asyncio.Queue
  - Background task fans out Redis messages to all queues
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis

from app.config import settings

logger = logging.getLogger(__name__)

# Channel name for Gantt updates
GANTT_CHANNEL = "gantt_updates"


class SSEManager:
    """
    Manages SSE connections using asyncio.Queue per-client
    and Redis Pub/Sub for cross-worker broadcast.
    """

    def __init__(self):
        self._clients: list[asyncio.Queue] = []
        self._redis: aioredis.Redis | None = None
        self._pubsub: aioredis.client.PubSub | None = None
        self._listener_task: asyncio.Task | None = None

    async def connect_redis(self) -> None:
        """Initialize Redis connection and start listening."""
        if self._redis is not None:
            return

        self._redis = aioredis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
        )
        self._pubsub = self._redis.pubsub()
        await self._pubsub.subscribe(GANTT_CHANNEL)

        # Start background listener
        self._listener_task = asyncio.create_task(self._redis_listener())
        logger.info("SSE Manager: Connected to Redis Pub/Sub on channel '%s'", GANTT_CHANNEL)

    async def disconnect_redis(self) -> None:
        """Clean up Redis connection."""
        if self._listener_task:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass

        if self._pubsub:
            await self._pubsub.unsubscribe(GANTT_CHANNEL)
            await self._pubsub.close()

        if self._redis:
            await self._redis.close()

        self._redis = None
        self._pubsub = None
        self._listener_task = None
        logger.info("SSE Manager: Disconnected from Redis Pub/Sub")

    async def _redis_listener(self) -> None:
        """Background task: read messages from Redis and fan out to all client queues."""
        try:
            async for message in self._pubsub.listen():
                if message["type"] == "message":
                    data = message["data"]
                    # Fan out to all connected clients
                    disconnected: list[asyncio.Queue] = []
                    for queue in self._clients:
                        try:
                            queue.put_nowait(data)
                        except asyncio.QueueFull:
                            disconnected.append(queue)

                    # Clean up full/dead queues
                    for q in disconnected:
                        self._clients.remove(q)

        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error("SSE Redis listener error: %s", e)

    def add_client(self) -> asyncio.Queue:
        """Register a new SSE client, returns its message queue."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._clients.append(queue)
        logger.info("SSE client connected. Total clients: %d", len(self._clients))
        return queue

    def remove_client(self, queue: asyncio.Queue) -> None:
        """Unregister an SSE client."""
        if queue in self._clients:
            self._clients.remove(queue)
        logger.info("SSE client disconnected. Total clients: %d", len(self._clients))

    async def publish(self, event_type: str, payload: dict[str, Any]) -> None:
        """
        Publish an event to Redis Pub/Sub channel.
        This broadcasts to all workers/instances.
        """
        if not self._redis:
            logger.warning("SSE Manager: Redis not connected, cannot publish")
            return

        event_data = json.dumps({
            "event": event_type,
            "data": payload,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

        await self._redis.publish(GANTT_CHANNEL, event_data)
        logger.debug("Published SSE event: %s", event_type)

    @property
    def client_count(self) -> int:
        return len(self._clients)


# Singleton
sse_manager = SSEManager()
