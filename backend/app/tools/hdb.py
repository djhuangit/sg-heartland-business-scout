from datetime import datetime, timezone

import httpx
from langchain_core.tools import tool

HDB_TENDERS_URL = "https://services2.hdb.gov.sg/webapp/AA16SalesflatWeb/AA16SERPListPage"


@tool
def fetch_hdb_tenders(town: str) -> dict:
    """Fetch active HDB commercial property tenders for a given town.
    Attempts to access HDB's commercial tenders listing."""
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "hdb_tenders",
        "raw_url": "https://www.hdb.gov.sg/business/commercial/commercial-properties/tender",
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
            "https://www.hdb.gov.sg/business/commercial/commercial-properties/tender",
            headers=headers,
            timeout=15,
            follow_redirects=True,
        )
        response.raise_for_status()
        result["fetch_status"] = "VERIFIED"
        result["data"] = response.text[:10000]  # Truncate HTML
        result["raw_url"] = str(response.url)
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    except httpx.TimeoutException:
        result["error"] = "timeout_15s"
    except httpx.HTTPStatusError as e:
        result["error"] = f"http_{e.response.status_code}"
    except Exception as e:
        result["error"] = str(e)
    return result
