from datetime import datetime, timezone

from loguru import logger
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage

from app.config import settings
from app.tools.singstat import fetch_population_demographics, fetch_household_income
from app.tools.web_search import search_web
from app.models.state import ScoutState
from app.routers._event_queue import emit

SYSTEM_PROMPT = """You are a demographics research agent for Singapore HDB towns.

STRICT DATA INTEGRITY RULES:
1. You MUST use the tool results as your ONLY source of factual data.
2. If a tool returns fetch_status="UNAVAILABLE", report that field as UNAVAILABLE.
   DO NOT estimate, guess, or use your training data as a substitute.
3. If a tool returns fetch_status="VERIFIED", use the data exactly as returned.
4. You MAY provide qualitative analysis and interpretation.
5. You MUST NOT invent quantitative data points.
6. For every number you report, you must cite which tool call produced it.

DATA FORMAT: Tool results contain structured JSON from data.gov.sg Census 2020:
- singstat_census provides: total_population, male_population, female_population,
  age_segments (pre-computed [{label, value, count}] with 5 life-stage groups:
    Children 0-14, Youth 15-24, Working Adults 25-44, Mid-Career 45-64, Seniors 65+),
  ethnicity (dict of ethnic fields -> count)
- singstat_income provides: income_distribution (dict of income_band -> household_count),
  AND pre-computed: median_household_income (int SGD), income_per_capita (int SGD),
  wealth_tier (string), total_households (int)
- web_search provides: supplementary data from government datasets

Your job: Extract demographics and wealth metrics for the given town.
Output a JSON object with:
- wealthMetrics: {medianHouseholdIncome, medianHouseholdIncomePerCapita, privatePropertyRatio, wealthTier, sourceNote, dataSourceUrl}
- demographicData: {residentPopulation, planningArea, ageDistribution, raceDistribution, employmentStatus, dataSourceUrl}
- discoveryLogs: list of {timestamp, action, result} entries documenting your research steps

CRITICAL: For wealthMetrics, use the pre-computed values from singstat_income:
- medianHouseholdIncome: format as "SGD X,XXX" using the median_household_income value
- medianHouseholdIncomePerCapita: format as "SGD X,XXX" using the income_per_capita value
- wealthTier: use the wealth_tier value directly
- Override wealthTier to "Silver Economy" if Seniors (65+) value exceeds 20%
- privatePropertyRatio: estimate from area context (e.g. "15%" for typical HDB towns)

CRITICAL: For ageDistribution, use the pre-computed age_segments array directly.
Copy the label and value fields into [{label, value}] format. Do NOT break them into finer bands.

For raceDistribution and employmentStatus, provide [{label, value}] arrays with percentage values.
Calculate percentages from the raw counts in the Census data.
"""


def demographics_agent(state: ScoutState) -> dict:
    """Fetch and interpret demographics & wealth data for the town."""
    town = state["town"]
    run_id = state.get("_run_id", "")
    now = datetime.now(timezone.utc).isoformat()
    logger.info("[demographics] Starting for {}", town)

    emit(run_id, "node_started", "demographics_agent")

    # Step 1: Fetch data using tools
    tool_results = []

    emit(run_id, "agent_log", "demographics_agent", {
        "type": "tool_start", "tool": "singstat_census",
        "message": f"Fetching Census 2020 population data for {town}..."
    })
    demo_result = fetch_population_demographics.invoke({"town": town})
    tool_results.append(demo_result)
    logger.info("[demographics] singstat_demographics: {}", demo_result["fetch_status"])
    emit(run_id, "agent_log", "demographics_agent", {
        "type": "tool_result", "tool": "singstat_census",
        "status": demo_result["fetch_status"],
        "message": f"singstat_census: {demo_result['fetch_status']}",
        "url": demo_result.get("raw_url"),
    })

    emit(run_id, "agent_log", "demographics_agent", {
        "type": "tool_start", "tool": "singstat_income",
        "message": f"Fetching household income distribution for {town}..."
    })
    income_result = fetch_household_income.invoke({"town": town})
    tool_results.append(income_result)
    logger.info("[demographics] singstat_income: {}", income_result["fetch_status"])
    emit(run_id, "agent_log", "demographics_agent", {
        "type": "tool_result", "tool": "singstat_income",
        "status": income_result["fetch_status"],
        "message": f"singstat_income: {income_result['fetch_status']}",
        "url": income_result.get("raw_url"),
    })

    emit(run_id, "agent_log", "demographics_agent", {
        "type": "tool_start", "tool": "web_search",
        "message": f"Searching web for {town} demographics supplementary data..."
    })
    web_result = search_web.invoke(
        {"query": f"{town} Singapore HDB planning area demographics population income 2024 2025"}
    )
    tool_results.append(web_result)
    logger.info("[demographics] web_search: {}", web_result["fetch_status"])
    emit(run_id, "agent_log", "demographics_agent", {
        "type": "tool_result", "tool": "web_search",
        "status": web_result["fetch_status"],
        "message": f"web_search: {web_result['fetch_status']}",
        "url": web_result.get("raw_url"),
    })

    # Step 2: Use LLM to interpret the tool results
    llm = ChatGoogleGenerativeAI(
        model="gemini-2.0-flash",
        google_api_key=settings.gemini_api_key,
    )

    tool_summary = ""
    for tr in tool_results:
        status = tr.get("fetch_status", "UNAVAILABLE")
        source = tr.get("source_id", "unknown")
        error = tr.get("error")
        data_preview = str(tr.get("data", ""))[:2000] if tr.get("data") else "NO DATA"
        tool_summary += f"\n--- Tool: {source} | Status: {status} | Error: {error} ---\n{data_preview}\n"

    emit(run_id, "agent_log", "demographics_agent", {
        "type": "llm_start",
        "message": f"Analyzing demographics with Gemini 2.0 Flash ({len(tool_summary)} chars input)..."
    })

    response = llm.invoke([
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=f"""Analyze demographics for {town}, Singapore.

Tool results:
{tool_summary}

Return a JSON object with wealthMetrics, demographicData, and discoveryLogs.
If a tool failed, mark that section's data as best-effort from available tools and note the failure in discoveryLogs.
"""),
    ])
    logger.info("[demographics] LLM response: {} chars", len(response.content))
    logger.success("[demographics] Complete for {}", town)

    preview = response.content[:200] + "..." if len(response.content) > 200 else response.content
    emit(run_id, "agent_log", "demographics_agent", {
        "type": "llm_done",
        "message": f"LLM response: {len(response.content)} chars",
        "preview": preview,
    })
    emit(run_id, "node_completed", "demographics_agent")

    # Build discovery logs
    logs = []
    for tr in tool_results:
        logs.append({
            "timestamp": now,
            "action": f"Fetched {tr.get('source_id', 'unknown')} for {town}",
            "result": f"Status: {tr['fetch_status']}" + (f" Error: {tr['error']}" if tr.get("error") else " OK"),
        })

    return {
        "demographics_raw": [{
            "agent": "demographics",
            "town": town,
            "llm_response": response.content,
            "tool_results": tool_results,
            "timestamp": now,
        }],
        "tool_calls": tool_results,
        "sources": [
            {"title": tr.get("source_id", ""), "uri": tr.get("raw_url", "")}
            for tr in tool_results
            if tr.get("raw_url")
        ],
    }
