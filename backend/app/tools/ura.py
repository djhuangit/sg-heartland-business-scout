from datetime import datetime, timezone

import httpx
from loguru import logger
from langchain_core.tools import tool


@tool
def fetch_ura_rental(town: str) -> dict:
    """Fetch URA rental transaction data for a given planning area.
    Attempts to access URA's property market information."""
    logger.debug("[tool:ura_rental] town={}", town)
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "ura_rental",
        "raw_url": "https://www.ura.gov.sg/property-market-information/pmiResidentialRentalSearch",
        "data": None,
        "error": None,
        "fetched_at": None,
        "town": town,
    }
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; HeartlandScout/1.0)",
        }
        response = httpx.get(
            "https://www.ura.gov.sg/property-market-information/pmiResidentialRentalSearch",
            headers=headers,
            timeout=15,
            follow_redirects=True,
        )
        response.raise_for_status()
        result["fetch_status"] = "VERIFIED"
        result["data"] = response.text[:10000]
        result["raw_url"] = str(response.url)
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    except httpx.TimeoutException:
        result["error"] = "timeout_15s"
    except httpx.HTTPStatusError as e:
        result["error"] = f"http_{e.response.status_code}"
    except Exception as e:
        result["error"] = str(e)
    logger.info("[tool:ura_rental] {} — {}", result["fetch_status"], town)
    return result
