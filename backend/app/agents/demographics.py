from datetime import datetime, timezone

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage

from app.config import settings
from app.tools.singstat import fetch_singstat_demographics, fetch_singstat_income
from app.tools.web_search import search_web
from app.models.state import ScoutState

SYSTEM_PROMPT = """You are a demographics research agent for Singapore HDB towns.

STRICT DATA INTEGRITY RULES:
1. You MUST use the tool results as your ONLY source of factual data.
2. If a tool returns fetch_status="UNAVAILABLE", report that field as UNAVAILABLE.
   DO NOT estimate, guess, or use your training data as a substitute.
3. If a tool returns fetch_status="VERIFIED", use the data exactly as returned.
4. You MAY provide qualitative analysis and interpretation.
5. You MUST NOT invent quantitative data points.
6. For every number you report, you must cite which tool call produced it.

Your job: Extract demographics and wealth metrics for the given town.
Output a JSON object with:
- wealthMetrics: {medianHouseholdIncome, medianHouseholdIncomePerCapita, privatePropertyRatio, wealthTier, sourceNote, dataSourceUrl}
- demographicData: {residentPopulation, planningArea, ageDistribution, raceDistribution, employmentStatus, dataSourceUrl}
- discoveryLogs: list of {timestamp, action, result} entries documenting your research steps

For wealthTier, classify as: "Mass Market", "Upper Mid", "Affluent", or "Silver Economy"
For distributions, provide [{label, value}] arrays with percentage values.
"""


def demographics_agent(state: ScoutState) -> dict:
    """Fetch and interpret demographics & wealth data for the town."""
    town = state["town"]
    now = datetime.now(timezone.utc).isoformat()

    # Step 1: Fetch data using tools
    tool_results = []

    demo_result = fetch_singstat_demographics.invoke({"town": town})
    tool_results.append(demo_result)

    income_result = fetch_singstat_income.invoke({"town": town})
    tool_results.append(income_result)

    web_result = search_web.invoke(
        {"query": f"{town} Singapore HDB planning area demographics population income 2024 2025"}
    )
    tool_results.append(web_result)

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

    response = llm.invoke([
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=f"""Analyze demographics for {town}, Singapore.

Tool results:
{tool_summary}

Return a JSON object with wealthMetrics, demographicData, and discoveryLogs.
If a tool failed, mark that section's data as best-effort from available tools and note the failure in discoveryLogs.
"""),
    ])

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
