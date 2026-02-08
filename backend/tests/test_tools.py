"""Test that all tools return correct provenance envelope structure."""

from app.tools.web_search import search_web
from app.tools.singstat import fetch_population_demographics, fetch_household_income
from app.tools.hdb import fetch_hdb_commercial
from app.tools.ura import fetch_rental_vacancy

REQUIRED_FIELDS = {"fetch_status", "source_id", "data", "error"}


def _check_envelope(result: dict):
    """Verify envelope structure."""
    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
    for field in REQUIRED_FIELDS:
        assert field in result, f"Missing field: {field}"
    assert result["fetch_status"] in (
        "VERIFIED", "STALE", "AI_ESTIMATED", "UNAVAILABLE"
    ), f"Invalid fetch_status: {result['fetch_status']}"
    # If failed, error should explain why
    if result["fetch_status"] == "UNAVAILABLE":
        assert result["data"] is None, "data should be None when UNAVAILABLE"


def test_search_web_envelope():
    result = search_web.invoke({"query": "test query"})
    _check_envelope(result)


def test_singstat_demographics_envelope():
    result = fetch_population_demographics.invoke({"town": "Tampines"})
    _check_envelope(result)
    assert result["source_id"] == "singstat_census"


def test_singstat_income_envelope():
    result = fetch_household_income.invoke({"town": "Tampines"})
    _check_envelope(result)
    assert result["source_id"] == "singstat_income"


def test_hdb_commercial_envelope():
    result = fetch_hdb_commercial.invoke({"town": "Tampines"})
    _check_envelope(result)
    assert result["source_id"] == "hdb_tenders"


def test_ura_rental_envelope():
    result = fetch_rental_vacancy.invoke({"town": "Tampines"})
    _check_envelope(result)
    assert result["source_id"] == "ura_rental"
