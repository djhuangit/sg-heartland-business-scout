from datetime import datetime, timezone

import httpx
from loguru import logger
from langchain_core.tools import tool

from app.tools._datagov import fetch_resource

# Census 2020 resource IDs on data.gov.sg
POPULATION_BY_AGE_SEX = "d_d95ae740c0f8961a0b10435836660ce0"
POPULATION_BY_ETHNICITY = "d_e7ae90176a68945837ad67892b898466"
HOUSEHOLD_INCOME = "d_2d6793de474551149c438ba349a108fd"

# Ordered income brackets with their midpoint values (SGD) for median calculation
_INCOME_BRACKETS: list[tuple[str, int]] = [
    ("NoEmployedPerson", 0),
    ("Below_1_000", 500),
    ("1_000_1_999", 1500),
    ("2_000_2_999", 2500),
    ("3_000_3_999", 3500),
    ("4_000_4_999", 4500),
    ("5_000_5_999", 5500),
    ("6_000_6_999", 6500),
    ("7_000_7_999", 7500),
    ("8_000_8_999", 8500),
    ("9_000_9_999", 9500),
    ("10_000_10_999", 10500),
    ("11_000_11_999", 11500),
    ("12_000_12_999", 12500),
    ("13_000_13_999", 13500),
    ("14_000_14_999", 14500),
    ("15_000_17_499", 16250),
    ("17_500_19_999", 18750),
    ("20_000andOver", 22500),
]


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


# 5 life-stage segments: raw Census field prefixes → segment label
_LIFE_STAGE_SEGMENTS: list[tuple[str, list[str]]] = [
    ("Children (0-14)", ["0_4", "5_9", "10_14"]),
    ("Youth (15-24)", ["15_19", "20_24"]),
    ("Working Adults (25-44)", ["25_29", "30_34", "35_39", "40_44"]),
    ("Mid-Career (45-64)", ["45_49", "50_54", "55_59", "60_64"]),
    ("Seniors (65+)", ["65_69", "70_74", "75_79", "80_84", "85_89", "90andOver"]),
]


def _aggregate_age_segments(record: dict) -> list[dict]:
    """Aggregate fine-grained age bands into 5 life-stage segments with percentages."""
    total = int(record.get("Total_Total") or 0)
    if total == 0:
        return []

    segments = []
    for label, bands in _LIFE_STAGE_SEGMENTS:
        count = sum(int(record.get(f"Total_{b}") or 0) for b in bands)
        pct = round(count / total * 100, 1)
        segments.append({"label": label, "value": pct, "count": count})
    return segments


def _compute_income_metrics(record: dict) -> dict:
    """Compute median household income, per-capita income, and wealth tier from bracket counts."""
    # Build list of (midpoint, count) excluding NoEmployedPerson for income stats
    employed_brackets = []
    total_households = 0
    for field, midpoint in _INCOME_BRACKETS:
        count = int(record.get(field) or 0)
        total_households += count
        if field != "NoEmployedPerson":
            employed_brackets.append((midpoint, count))

    employed_total = sum(c for _, c in employed_brackets)
    if employed_total == 0:
        return {
            "median_household_income": None,
            "income_per_capita": None,
            "wealth_tier": "Mass Market",
            "total_households": total_households,
        }

    # Median: find the bracket containing the middle employed household
    target = employed_total / 2
    cumulative = 0
    median = 0
    for midpoint, count in employed_brackets:
        cumulative += count
        if cumulative >= target:
            median = midpoint
            break

    # Weighted average income (proxy for per-capita using avg household size ~3.1)
    weighted_sum = sum(mid * cnt for mid, cnt in employed_brackets)
    avg_income = weighted_sum / employed_total
    income_per_capita = round(avg_income / 3.1)

    # Wealth tier based on median
    if median >= 10000:
        wealth_tier = "Affluent"
    elif median >= 5000:
        wealth_tier = "Upper Mid"
    else:
        wealth_tier = "Mass Market"

    return {
        "median_household_income": median,
        "income_per_capita": income_per_capita,
        "wealth_tier": wealth_tier,
        "total_households": total_households,
    }


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

        age_segments = _aggregate_age_segments(town_pop) if town_pop else []

        eth_data = fetch_resource(POPULATION_BY_ETHNICITY, limit=400)
        eth_records = eth_data.get("records", [])
        town_eth = _find_town_record(eth_records, town)

        result["fetch_status"] = "VERIFIED"
        result["data"] = {
            "town": town,
            "total_population": int(town_pop["Total_Total"]) if town_pop and town_pop.get("Total_Total") else None,
            "male_population": int(town_pop["Males_Total"]) if town_pop and town_pop.get("Males_Total") else None,
            "female_population": int(town_pop["Females_Total"]) if town_pop and town_pop.get("Females_Total") else None,
            "age_segments": age_segments,
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

        income_distribution = {}
        metrics = {}
        if town_income:
            income_distribution = {
                k: v for k, v in town_income.items()
                if k not in ("_id", "Number") and v
            }
            metrics = _compute_income_metrics(town_income)

        result["fetch_status"] = "VERIFIED"
        result["data"] = {
            "town": town,
            "income_distribution": income_distribution,
            "median_household_income": metrics.get("median_household_income"),
            "income_per_capita": metrics.get("income_per_capita"),
            "wealth_tier": metrics.get("wealth_tier"),
            "total_households": metrics.get("total_households"),
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
