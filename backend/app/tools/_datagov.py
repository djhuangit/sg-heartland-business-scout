"""Shared data.gov.sg API client with rate limiting and retry logic."""

import threading
import time

import httpx
from loguru import logger

from app.config import settings

DATAGOV_API = "https://data.gov.sg/api/action/datastore_search"
_MAX_RETRIES = 4
_RETRY_BASE_WAIT = 3  # seconds

# Global rate limiter: enforce minimum 2.5s gap between requests
# (data.gov.sg allows 4 req/10s without API key)
_lock = threading.Lock()
_last_request_time = 0.0
_MIN_INTERVAL = 2.5  # seconds between requests (without API key)
_MIN_INTERVAL_WITH_KEY = 1.0  # seconds between requests (with API key)


def _headers() -> dict:
    """Build headers — includes API key if configured."""
    headers = {"Accept": "application/json"}
    if settings.datagov_api_key:
        headers["x-api-key"] = settings.datagov_api_key
    return headers


def _rate_limit_wait():
    """Wait if needed to respect rate limits."""
    global _last_request_time
    interval = _MIN_INTERVAL_WITH_KEY if settings.datagov_api_key else _MIN_INTERVAL
    with _lock:
        now = time.monotonic()
        elapsed = now - _last_request_time
        if elapsed < interval:
            wait = interval - elapsed
            logger.debug("[datagov] Rate limit wait: {:.1f}s", wait)
            time.sleep(wait)
        _last_request_time = time.monotonic()


def fetch_resource(
    resource_id: str,
    q: str | None = None,
    filters: dict | None = None,
    sort: str | None = None,
    limit: int = 200,
) -> dict:
    """Fetch records from data.gov.sg datastore with automatic retry on 429."""
    import json as _json

    params: dict = {"resource_id": resource_id, "limit": limit}
    if q:
        params["q"] = q
    if filters:
        params["filters"] = _json.dumps(filters)
    if sort:
        params["sort"] = sort

    for attempt in range(_MAX_RETRIES):
        _rate_limit_wait()
        resp = httpx.get(DATAGOV_API, params=params, headers=_headers(), timeout=15)
        if resp.status_code == 429 and attempt < _MAX_RETRIES - 1:
            wait = _RETRY_BASE_WAIT * (attempt + 1)
            logger.warning("[datagov] 429 rate limited, retrying in {}s (attempt {}/{})",
                           wait, attempt + 1, _MAX_RETRIES)
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp.json().get("result", {})

    resp.raise_for_status()
    return resp.json().get("result", {})
