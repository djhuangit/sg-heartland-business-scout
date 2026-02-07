from datetime import datetime, timezone

import httpx
from loguru import logger
from langchain_core.tools import tool

SINGSTAT_URL = "https://www.singstat.gov.sg/find-data/search-by-theme/population/geographic-distribution/latest-data"
SINGSTAT_TABLE_URL = "https://tablebuilder.singstat.gov.sg/api/table/tabledata"


@tool
def fetch_singstat_demographics(town: str) -> dict:
    """Fetch demographic data for a Singapore planning area from SingStat.
    Attempts to access SingStat Table Builder API for census data."""
    logger.debug("[tool:singstat_census] town={}", town)
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "singstat_census",
        "raw_url": SINGSTAT_URL,
        "data": None,
        "error": None,
        "fetched_at": None,
        "town": town,
    }
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; HeartlandScout/1.0)",
            "Accept": "application/json",
        }
        # Try SingStat Table Builder API for resident population by planning area
        # Table ID 17564 is "Resident Population by Planning Area/Subzone and Type of Dwelling"
        response = httpx.get(
            SINGSTAT_TABLE_URL,
            params={"id": "17564"},
            headers=headers,
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        result["fetch_status"] = "VERIFIED"
        result["data"] = data
        result["raw_url"] = f"{SINGSTAT_TABLE_URL}?id=17564"
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    except httpx.TimeoutException:
        result["error"] = "timeout_15s"
    except httpx.HTTPStatusError as e:
        result["error"] = f"http_{e.response.status_code}"
    except Exception as e:
        result["error"] = str(e)
    logger.info("[tool:singstat_census] {} — {}", result["fetch_status"], town)
    return result


@tool
def fetch_singstat_income(town: str) -> dict:
    """Fetch household income data for a Singapore planning area from SingStat."""
    logger.debug("[tool:singstat_income] town={}", town)
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "singstat_income",
        "raw_url": "https://www.singstat.gov.sg/find-data/search-by-theme/households/household-income",
        "data": None,
        "error": None,
        "fetched_at": None,
        "town": town,
    }
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; HeartlandScout/1.0)",
            "Accept": "application/json",
        }
        response = httpx.get(
            SINGSTAT_TABLE_URL,
            params={"id": "17009"},
            headers=headers,
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        result["fetch_status"] = "VERIFIED"
        result["data"] = data
        result["raw_url"] = f"{SINGSTAT_TABLE_URL}?id=17009"
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    except httpx.TimeoutException:
        result["error"] = "timeout_15s"
    except httpx.HTTPStatusError as e:
        result["error"] = f"http_{e.response.status_code}"
    except Exception as e:
        result["error"] = str(e)
    logger.info("[tool:singstat_income] {} — {}", result["fetch_status"], town)
    return result
