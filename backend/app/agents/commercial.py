from datetime import datetime, timezone

from loguru import logger
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage

from app.config import settings
from app.tools.hdb import fetch_hdb_commercial
from app.tools.ura import fetch_rental_vacancy
from app.tools.web_search import search_web
from app.models.state import ScoutState
from app.routers._event_queue import emit

SYSTEM_PROMPT = """You are a commercial property research agent for Singapore HDB towns.

STRICT DATA INTEGRITY RULES:
1. You MUST use the tool results as your ONLY source of factual data.
2. If a tool returns fetch_status="UNAVAILABLE", report that field as UNAVAILABLE.
   DO NOT estimate, guess, or use your training data as a substitute.
3. If a tool returns fetch_status="VERIFIED", use the data exactly as returned.
4. You MAY provide qualitative analysis and interpretation.
5. You MUST NOT invent quantitative data points.

DATA FORMAT: Tool results contain structured JSON from data.gov.sg:
- hdb_tenders provides: resale_transactions (list of {month, town, flat_type, block, street_name,
  storey_range, floor_area_sqm, resale_price}), resale_avg_price, resale_flat_type_mix,
  commercial_properties (list of HDB commercial property records)
- ura_rental provides: office_rental_vacancy (list of {quarter, category, office_med_rental_lc,
  office_med_rental_cd, office_vacancy_rate}), hdb_median_rents (list of {quarter, town,
  flat_type, median_rent})
- web_search provides: supplementary HDB resale and rental data

Your job: Extract commercial property data for the given town.
Output a JSON object with:
- activeTenders: list of {block, street, closingDate, status, areaSqft}
  - If no tender data is available, return an empty list and note in discoveryLogs
- rentalData: {medianRental, trend, dataSourceUrl}
  - Use office vacancy rates and HDB median rents to estimate commercial rental trends
  - Use resale price trends as a proxy for rental demand
- discoveryLogs: list of {timestamp, action, result} entries
"""


def commercial_agent(state: ScoutState) -> dict:
    """Fetch HDB tenders and URA rental data for the town."""
    town = state["town"]
    run_id = state.get("_run_id", "")
    now = datetime.now(timezone.utc).isoformat()
    logger.info("[commercial] Starting for {}", town)

    emit(run_id, "node_started", "commercial_agent")

    tool_results = []

    emit(run_id, "agent_log", "commercial_agent", {
        "type": "tool_start", "tool": "hdb_commercial",
        "message": f"Fetching HDB resale & commercial data for {town}..."
    })
    hdb_result = fetch_hdb_commercial.invoke({"town": town})
    tool_results.append(hdb_result)
    logger.info("[commercial] hdb_commercial: {}", hdb_result["fetch_status"])
    emit(run_id, "agent_log", "commercial_agent", {
        "type": "tool_result", "tool": "hdb_commercial",
        "status": hdb_result["fetch_status"],
        "message": f"hdb_commercial: {hdb_result['fetch_status']}",
        "url": hdb_result.get("raw_url"),
    })

    emit(run_id, "agent_log", "commercial_agent", {
        "type": "tool_start", "tool": "ura_rental",
        "message": f"Fetching URA rental & vacancy data..."
    })
    ura_result = fetch_rental_vacancy.invoke({"town": town})
    tool_results.append(ura_result)
    logger.info("[commercial] rental_vacancy: {}", ura_result["fetch_status"])
    emit(run_id, "agent_log", "commercial_agent", {
        "type": "tool_result", "tool": "ura_rental",
        "status": ura_result["fetch_status"],
        "message": f"ura_rental: {ura_result['fetch_status']}",
        "url": ura_result.get("raw_url"),
    })

    emit(run_id, "agent_log", "commercial_agent", {
        "type": "tool_start", "tool": "web_search",
        "message": f"Searching web for {town} commercial & tender data..."
    })
    web_result = search_web.invoke(
        {"query": f"{town} Singapore HDB commercial tender 2025 2026 rental psf"}
    )
    tool_results.append(web_result)
    logger.info("[commercial] web_search: {}", web_result["fetch_status"])
    emit(run_id, "agent_log", "commercial_agent", {
        "type": "tool_result", "tool": "web_search",
        "status": web_result["fetch_status"],
        "message": f"web_search: {web_result['fetch_status']}",
        "url": web_result.get("raw_url"),
    })

    llm = ChatGoogleGenerativeAI(
        model="gemini-3-flash-preview",
        google_api_key=settings.gemini_api_key,
    )

    tool_summary = ""
    for tr in tool_results:
        status = tr.get("fetch_status", "UNAVAILABLE")
        source = tr.get("source_id", "unknown")
        error = tr.get("error")
        data_preview = str(tr.get("data", ""))[:2000] if tr.get("data") else "NO DATA"
        tool_summary += f"\n--- Tool: {source} | Status: {status} | Error: {error} ---\n{data_preview}\n"

    emit(run_id, "agent_log", "commercial_agent", {
        "type": "llm_start",
        "message": f"Analyzing commercial data with Gemini 3 Flash ({len(tool_summary)} chars input)..."
    })

    response = llm.invoke([
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=f"""Analyze commercial property data for {town}, Singapore. Today is {now[:10]}.

Tool results:
{tool_summary}

Return a JSON object with activeTenders, rentalData, and discoveryLogs.
If tools failed, note failures in discoveryLogs and mark data accordingly.
"""),
    ])
    logger.info("[commercial] LLM response: {} chars", len(response.content))
    logger.success("[commercial] Complete for {}", town)

    preview = response.content[:200] + "..." if len(response.content) > 200 else response.content
    emit(run_id, "agent_log", "commercial_agent", {
        "type": "llm_done",
        "message": f"LLM response: {len(response.content)} chars",
        "preview": preview,
    })
    emit(run_id, "node_completed", "commercial_agent")

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
