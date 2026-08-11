"""
SSE (Server-Sent Events) Endpoint.
/api/events with proxy_buffering off in Nginx.

Clients connect to GET /api/events to receive real-time updates:
  - TASK_UPDATED: A delivery split was dragged
  - TASK_SPLIT: A delivery split was divided
  - TASK_CREATED: New orders from Excel import
  - TASK_DELETED: Orders soft-deleted from Excel diff
"""

import asyncio
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.models.user import User
from app.api.deps import get_current_user
from app.services.sse_service import sse_manager

router = APIRouter(tags=["Server-Sent Events"])


async def _event_generator(request: Request, queue: asyncio.Queue):
    """
    Async generator that yields SSE-formatted messages.
    Keeps the connection alive with periodic heartbeats.
    """
    try:
        while True:
            # Check if client disconnected
            if await request.is_disconnected():
                break

            try:
                # Wait for message with timeout (heartbeat every 30s)
                message = await asyncio.wait_for(queue.get(), timeout=30.0)
                # Parse the message to extract event type
                try:
                    parsed = json.loads(message)
                    event_type = parsed.get("event", "message")
                    data = json.dumps(parsed)
                except (json.JSONDecodeError, TypeError):
                    event_type = "message"
                    data = str(message)

                yield f"event: {event_type}\ndata: {data}\n\n"

            except asyncio.TimeoutError:
                # Send heartbeat comment to keep connection alive
                yield ": heartbeat\n\n"

    except asyncio.CancelledError:
        pass


@router.get(
    "/events",
    summary="SSE stream for real-time Gantt updates",
    response_class=StreamingResponse,
)
async def sse_stream(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """
    Server-Sent Events endpoint.
    Streams real-time updates to connected clients.

    Event types:
      - TASK_UPDATED: Delivery split dates changed (drag-and-drop)
      - TASK_SPLIT: Delivery split divided into two
      - TASK_CREATED: New orders imported
      - TASK_DELETED: Orders soft-deleted

    Requires authentication via Bearer token (query param or header).
    """
    queue = sse_manager.add_client()

    async def cleanup_generator():
        try:
            async for event in _event_generator(request, queue):
                yield event
        finally:
            sse_manager.remove_client(queue)

    return StreamingResponse(
        cleanup_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Nginx: disable buffering
        },
    )
