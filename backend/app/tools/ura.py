from datetime import datetime, timezone

import httpx
from loguru import logger
from langchain_core.tools import tool

from app.tools._datagov import fetch_resource

# data.gov.sg resource IDs
OFFICE_RENTAL_VACANCY = "d_402d5cdfbc194e25e326ba3f274bebb6"
HDB_MEDIAN_RENT = "d_23000a00c52996c55106084ed0339566"


@tool
def fetch_rental_vacancy(town: str) -> dict:
    """Fetch office/retail rental and vacancy data plus HDB median rents from data.gov.sg."""
    logger.debug("[tool:ura_rental] town={}", town)
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "ura_rental",
        "raw_url": f"https://data.gov.sg/datasets/{OFFICE_RENTAL_VACANCY}",
        "data": None,
        "error": None,
        "fetched_at": None,
        "town": town,
    }
    try:
        # Office/retail rental and vacancy rates (national level)
        rental_data = fetch_resource(OFFICE_RENTAL_VACANCY, sort="_id desc", limit=50)

        # HDB median rent by town and flat type
        hdb_rent_data = fetch_resource(HDB_MEDIAN_RENT, q=town, limit=50)

        rental_records = rental_data.get("records", [])
        hdb_rent_records = hdb_rent_data.get("records", [])

        result["fetch_status"] = "VERIFIED"
        result["data"] = {
            "town": town,
            "office_rental_vacancy": rental_records[:30],
            "office_total_records": rental_data.get("total", 0),
            "hdb_median_rents": hdb_rent_records[:20],
            "hdb_rent_total_records": hdb_rent_data.get("total", 0),
            "source": "URA/HDB via data.gov.sg",
        }
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    except httpx.TimeoutException:
        result["error"] = "timeout_15s"
    except httpx.HTTPStatusError as e:
        result["error"] = f"http_{e.response.status_code}"
    except Exception as e:
        result["error"] = str(e)
    logger.info("[tool:ura_rental] {} — {}", result["fetch_status"], town)
    return result
