from datetime import datetime, timezone

import httpx
from loguru import logger
from langchain_core.tools import tool

from app.tools._datagov import fetch_resource

# data.gov.sg resource IDs for general business context
HDB_RESALE_PRICES = "d_8b84c4ee58e3cfc0ece0d773c8ca6abc"
OFFICE_RENTAL_VACANCY = "d_402d5cdfbc194e25e326ba3f274bebb6"
POPULATION_BY_AGE = "d_d95ae740c0f8961a0b10435836660ce0"
HDB_MEDIAN_RENT = "d_23000a00c52996c55106084ed0339566"

# Known HDB town names for extraction from queries
KNOWN_TOWNS = {
    "ANG MO KIO", "BEDOK", "BISHAN", "BUKIT BATOK", "BUKIT MERAH",
    "BUKIT PANJANG", "BUKIT TIMAH", "CENTRAL AREA", "CHOA CHU KANG",
    "CLEMENTI", "GEYLANG", "HOUGANG", "JURONG EAST", "JURONG WEST",
    "KALLANG/WHAMPOA", "MARINE PARADE", "PASIR RIS", "PUNGGOL",
    "QUEENSTOWN", "SEMBAWANG", "SENGKANG", "SERANGOON", "TAMPINES",
    "TOA PAYOH", "WOODLANDS", "YISHUN", "TENGAH",
}


def _extract_town(query: str) -> str | None:
    """Try to extract a known town name from the query string."""
    q_upper = query.upper()
    for town in KNOWN_TOWNS:
        if town in q_upper:
            return town
    for town in KNOWN_TOWNS:
        for word in town.split():
            if len(word) > 3 and word in q_upper:
                return town
    return None


@tool
def search_web(query: str) -> dict:
    """Search Singapore government open data for business, demographic, or property information relevant to the query."""
    logger.debug("[tool:web_search] query={}", query[:80])
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "web_search",
        "data": None,
        "raw_url": "https://data.gov.sg",
        "error": None,
        "fetched_at": None,
        "query": query,
    }
    try:
        town = _extract_town(query)
        q_lower = query.lower()
        all_data: dict = {}
        datasets_queried: list[str] = []

        if any(w in q_lower for w in ["food", "f&b", "restaurant", "shop", "retail", "business", "hawker", "cafe", "market"]):
            datasets_queried.append("hdb_resale_context")
            filter_params = {"town": town} if town else None
            data = fetch_resource(HDB_RESALE_PRICES, filters=filter_params, sort="month desc", limit=30)
            records = data.get("records", [])[:20]
            all_data["hdb_resale"] = records
            # Also get HDB median rent for commercial context
            datasets_queried.append("hdb_median_rent")
            rent_data = fetch_resource(HDB_MEDIAN_RENT, q=town or query.split()[0], limit=30)
            all_data["hdb_median_rents"] = rent_data.get("records", [])[:20]

        if any(w in q_lower for w in ["population", "demographic", "income", "resident", "census"]):
            datasets_queried.append("demographics")
            data = fetch_resource(POPULATION_BY_AGE, limit=400)
            # Filter locally for town
            if town:
                filtered = [r for r in data.get("records", []) if town.lower() in (r.get("Number") or "").lower()]
                all_data["demographics"] = filtered[:20]
            else:
                all_data["demographics"] = data.get("records", [])[:20]

        if any(w in q_lower for w in ["vacancy", "rental", "office", "commercial", "rent", "lease"]):
            datasets_queried.append("rental_vacancy")
            data = fetch_resource(OFFICE_RENTAL_VACANCY, limit=30)
            all_data["rental_vacancy"] = data.get("records", [])[:20]

        if any(w in q_lower for w in ["resale", "hdb", "flat", "property", "price"]):
            datasets_queried.append("hdb_resale")
            filter_params = {"town": town} if town else None
            data = fetch_resource(HDB_RESALE_PRICES, filters=filter_params, sort="month desc", limit=30)
            all_data["hdb_resale"] = data.get("records", [])[:20]

        # Default: fetch HDB resale + median rent (most useful for business scouting context)
        if not datasets_queried:
            datasets_queried.append("hdb_resale_default")
            filter_params = {"town": town} if town else None
            data = fetch_resource(HDB_RESALE_PRICES, filters=filter_params, sort="month desc", limit=30)
            all_data["hdb_resale"] = data.get("records", [])[:20]

        all_data["datasets_queried"] = datasets_queried
        all_data["town_extracted"] = town

        result["fetch_status"] = "VERIFIED"
        result["data"] = all_data
        result["raw_url"] = "https://data.gov.sg"
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    except httpx.TimeoutException:
        result["error"] = "timeout_15s"
    except httpx.HTTPStatusError as e:
        result["error"] = f"http_{e.response.status_code}"
    except Exception as e:
        result["error"] = str(e)
    logger.info("[tool:web_search] {} — {}", result["fetch_status"], query[:50])
    return result
