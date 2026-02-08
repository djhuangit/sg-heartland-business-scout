"""Thread-safe event queue for real-time SSE streaming from agents."""
import queue
import threading
from datetime import datetime, timezone


_queues: dict[str, queue.Queue] = {}
_lock = threading.Lock()


def create_queue(run_id: str) -> queue.Queue:
    q = queue.Queue()
    with _lock:
        _queues[run_id] = q
    return q


def get_queue(run_id: str) -> queue.Queue | None:
    return _queues.get(run_id)


def remove_queue(run_id: str):
    with _lock:
        _queues.pop(run_id, None)


def emit(run_id: str, event_type: str, node: str, detail: dict = None):
    """Push an event to the run's queue (called from agent threads)."""
    q = _queues.get(run_id)
    if q:
        q.put({
            "event_type": event_type,
            "node": node,
            "detail": detail or {},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
