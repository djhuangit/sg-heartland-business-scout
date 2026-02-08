from datetime import datetime, timezone

import httpx
from loguru import logger
from langchain_core.tools import tool

from app.tools._datagov import fetch_resource

# data.gov.sg resource IDs
HDB_COMMERCIAL_PROPERTIES = "d_a32043811ffb2e44c861fa24c4c425d1"
HDB_RESALE_PRICES = "d_8b84c4ee58e3cfc0ece0d773c8ca6abc"


@tool
def fetch_hdb_commercial(town: str) -> dict:
    """Fetch HDB commercial property data and recent resale prices for a Singapore town from data.gov.sg."""
    logger.debug("[tool:hdb_tenders] town={}", town)
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "hdb_tenders",
        "raw_url": f"https://data.gov.sg/datasets/{HDB_RESALE_PRICES}",
        "data": None,
        "error": None,
        "fetched_at": None,
        "town": town,
    }
    try:
        # HDB resale flat prices for the town (most recent first)
        resale_data = fetch_resource(
            HDB_RESALE_PRICES,
            filters={"town": town.upper()},
            sort="month desc",
            limit=50,
        )

        # HDB commercial properties (sold/rented by financial year)
        comm_data = fetch_resource(HDB_COMMERCIAL_PROPERTIES, q=town, limit=100)

        resale_records = resale_data.get("records", [])
        comm_records = comm_data.get("records", [])

        # Compute summary stats from resale data
        prices = [int(r["resale_price"]) for r in resale_records if r.get("resale_price")]
        avg_price = sum(prices) // len(prices) if prices else None
        flat_types: dict[str, int] = {}
        for r in resale_records:
            ft = r.get("flat_type", "Unknown")
            flat_types[ft] = flat_types.get(ft, 0) + 1

        result["fetch_status"] = "VERIFIED"
        result["data"] = {
            "town": town,
            "resale_transactions": resale_records[:20],
            "resale_total_records": resale_data.get("total", 0),
            "resale_avg_price": avg_price,
            "resale_flat_type_mix": flat_types,
            "commercial_properties": comm_records[:30],
            "commercial_total_records": comm_data.get("total", 0),
            "source": "HDB, data.gov.sg",
        }
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    except httpx.TimeoutException:
        result["error"] = "timeout_15s"
    except httpx.HTTPStatusError as e:
        result["error"] = f"http_{e.response.status_code}"
    except Exception as e:
        result["error"] = str(e)
    logger.info("[tool:hdb_tenders] {} — {}", result["fetch_status"], town)
    return result
