from datetime import datetime, timezone

import httpx
from loguru import logger
from langchain_core.tools import tool

from app.tools._datagov import fetch_resource

# Census 2020 resource IDs on data.gov.sg
POPULATION_BY_AGE_SEX = "d_d95ae740c0f8961a0b10435836660ce0"
POPULATION_BY_ETHNICITY = "d_e7ae90176a68945837ad67892b898466"
HOUSEHOLD_INCOME = "d_2d6793de474551149c438ba349a108fd"


def _find_town_record(records: list[dict], town: str) -> dict | None:
    """Find the town-level total record by matching the Number field."""
    town_upper = town.upper().strip()
    for rec in records:
        num = (rec.get("Number") or "").strip()
        if num.upper() == f"{town_upper} - TOTAL" or num.upper() == town_upper:
            return rec
        if num.upper().startswith(town_upper) and num.endswith("- Total"):
            return rec
    return None


@tool
def fetch_population_demographics(town: str) -> dict:
    """Fetch Census 2020 population demographics (age, sex, ethnicity) for a Singapore planning area from data.gov.sg."""
    logger.debug("[tool:singstat_census] town={}", town)
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "singstat_census",
        "raw_url": f"https://data.gov.sg/datasets/{POPULATION_BY_AGE_SEX}",
        "data": None,
        "error": None,
        "fetched_at": None,
        "town": town,
    }
    try:
        # Census datasets are small (~400 records) — fetch all and filter locally
        # (q param doesn't work reliably for these datasets)
        pop_data = fetch_resource(POPULATION_BY_AGE_SEX, limit=400)
        pop_records = pop_data.get("records", [])
        town_pop = _find_town_record(pop_records, town)

        age_distribution = {}
        if town_pop:
            for key, val in town_pop.items():
                if key.startswith("Total_") and key != "Total_Total":
                    age_band = key.replace("Total_", "").replace("_", "-").replace("andOver", "+")
                    age_distribution[age_band] = int(val) if val else 0

        eth_data = fetch_resource(POPULATION_BY_ETHNICITY, limit=400)
        eth_records = eth_data.get("records", [])
        town_eth = _find_town_record(eth_records, town)

        result["fetch_status"] = "VERIFIED"
        result["data"] = {
            "town": town,
            "total_population": int(town_pop["Total_Total"]) if town_pop and town_pop.get("Total_Total") else None,
            "male_population": int(town_pop["Males_Total"]) if town_pop and town_pop.get("Males_Total") else None,
            "female_population": int(town_pop["Females_Total"]) if town_pop and town_pop.get("Females_Total") else None,
            "age_distribution": age_distribution,
            "ethnicity": {
                k: v for k, v in (town_eth or {}).items()
                if k not in ("_id", "Number") and v
            } if town_eth else {},
            "source": "Census of Population 2020, data.gov.sg",
        }
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
def fetch_household_income(town: str) -> dict:
    """Fetch Census 2020 household income data for a Singapore planning area from data.gov.sg."""
    logger.debug("[tool:singstat_income] town={}", town)
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "singstat_income",
        "raw_url": f"https://data.gov.sg/datasets/{HOUSEHOLD_INCOME}",
        "data": None,
        "error": None,
        "fetched_at": None,
        "town": town,
    }
    try:
        income_data = fetch_resource(HOUSEHOLD_INCOME, limit=400)
        records = income_data.get("records", [])
        town_income = _find_town_record(records, town)

        result["fetch_status"] = "VERIFIED"
        result["data"] = {
            "town": town,
            "income_distribution": {
                k: v for k, v in (town_income or {}).items()
                if k not in ("_id", "Number") and v
            } if town_income else {},
            "total_records": income_data.get("total", 0),
            "source": "Census of Population 2020, data.gov.sg",
        }
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    except httpx.TimeoutException:
        result["error"] = "timeout_15s"
    except httpx.HTTPStatusError as e:
        result["error"] = f"http_{e.response.status_code}"
    except Exception as e:
        result["error"] = str(e)
    logger.info("[tool:singstat_income] {} — {}", result["fetch_status"], town)
    return result
