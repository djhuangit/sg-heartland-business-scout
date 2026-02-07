from datetime import datetime, timezone

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage

from app.config import settings
from app.tools.hdb import fetch_hdb_tenders
from app.tools.ura import fetch_ura_rental
from app.tools.web_search import search_web
from app.models.state import ScoutState

SYSTEM_PROMPT = """You are a commercial property research agent for Singapore HDB towns.

STRICT DATA INTEGRITY RULES:
1. You MUST use the tool results as your ONLY source of factual data.
2. If a tool returns fetch_status="UNAVAILABLE", report that field as UNAVAILABLE.
   DO NOT estimate, guess, or use your training data as a substitute.
3. If a tool returns fetch_status="VERIFIED", use the data exactly as returned.
4. You MAY provide qualitative analysis and interpretation.
5. You MUST NOT invent quantitative data points.

Your job: Extract commercial property data for the given town.
Output a JSON object with:
- activeTenders: list of {block, street, closingDate, status, areaSqft}
  - status must be OPEN, CLOSED, or AWARDED based on closingDate vs today
- rentalData: {medianRental, trend, dataSourceUrl}
- discoveryLogs: list of {timestamp, action, result} entries

For tender status:
- If closingDate > today → OPEN
- If closingDate < today → CLOSED or AWARDED
"""


def commercial_agent(state: ScoutState) -> dict:
    """Fetch HDB tenders and URA rental data for the town."""
    town = state["town"]
    now = datetime.now(timezone.utc).isoformat()

    tool_results = []

    hdb_result = fetch_hdb_tenders.invoke({"town": town})
    tool_results.append(hdb_result)

    ura_result = fetch_ura_rental.invoke({"town": town})
    tool_results.append(ura_result)

    web_result = search_web.invoke(
        {"query": f"{town} Singapore HDB commercial tender 2025 2026 rental psf"}
    )
    tool_results.append(web_result)

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
        HumanMessage(content=f"""Analyze commercial property data for {town}, Singapore. Today is {now[:10]}.

Tool results:
{tool_summary}

Return a JSON object with activeTenders, rentalData, and discoveryLogs.
If tools failed, note failures in discoveryLogs and mark data accordingly.
"""),
    ])

    return {
        "commercial_raw": [{
            "agent": "commercial",
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
