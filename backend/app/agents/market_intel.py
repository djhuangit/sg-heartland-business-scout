from datetime import datetime, timezone

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage

from app.config import settings
from app.tools.web_search import search_web
from app.models.state import ScoutState

SYSTEM_PROMPT = """You are a market intelligence agent for Singapore HDB towns.

STRICT DATA INTEGRITY RULES:
1. You MUST use the tool results as your ONLY source of factual data.
2. If a tool returns fetch_status="UNAVAILABLE", report that field as UNAVAILABLE.
   DO NOT estimate, guess, or use your training data as a substitute.
3. If a tool returns fetch_status="VERIFIED", use the data exactly as returned.
4. You MAY provide qualitative analysis and interpretation.
5. You MUST NOT invent quantitative data points.

Your job: Analyze the business landscape for the given town.
Output a JSON object with:
- businessMix: overview of existing businesses by category (F&B, Retail, Services, etc.)
- saturationAnalysis: which categories are saturated vs underserved
- footTrafficEstimate: qualitative assessment based on MRT/bus proximity
- discoveryLogs: list of {timestamp, action, result} entries
"""


def market_intel_agent(state: ScoutState) -> dict:
    """Analyze business mix, saturation, and foot traffic for the town."""
    town = state["town"]
    now = datetime.now(timezone.utc).isoformat()

    tool_results = []

    # Search for business mix
    biz_result = search_web.invoke(
        {"query": f"{town} Singapore HDB shops business directory F&B retail 2025"}
    )
    tool_results.append(biz_result)

    # Search for foot traffic / transport
    traffic_result = search_web.invoke(
        {"query": f"{town} Singapore MRT station bus interchange foot traffic daily ridership"}
    )
    tool_results.append(traffic_result)

    # Search for saturation / competition
    sat_result = search_web.invoke(
        {"query": f"{town} Singapore new shop openings commercial vacancy rate 2025 2026"}
    )
    tool_results.append(sat_result)

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
        HumanMessage(content=f"""Analyze business landscape for {town}, Singapore.

Tool results:
{tool_summary}

Return a JSON object with businessMix, saturationAnalysis, footTrafficEstimate, and discoveryLogs.
If tools failed, note failures in discoveryLogs.
"""),
    ])

    return {
        "market_intel_raw": [{
            "agent": "market_intel",
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
