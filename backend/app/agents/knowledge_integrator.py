import json
from datetime import datetime, timezone

from loguru import logger
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage

from app.config import settings
from app.models.state import MarathonState
from app.routers._event_queue import emit

SYSTEM_PROMPT = """You are a knowledge integration agent. Your job is to synthesize raw agent outputs
into a complete AreaAnalysis JSON object that matches this exact structure:

{
  "town": string,
  "commercialPulse": string (1-2 sentence summary of commercial outlook),
  "demographicsFocus": string (primary target demographic segment),
  "wealthMetrics": {
    "medianHouseholdIncome": string,
    "medianHouseholdIncomePerCapita": string,
    "privatePropertyRatio": string,
    "wealthTier": "Mass Market" | "Upper Mid" | "Affluent" | "Silver Economy",
    "sourceNote": string,
    "dataSourceUrl": string
  },
  "demographicData": {
    "residentPopulation": string,
    "planningArea": string,
    "ageDistribution": [{"label": string, "value": number}],
    "raceDistribution": [{"label": string, "value": number}],
    "employmentStatus": [{"label": string, "value": number}],
    "dataSourceUrl": string
  },
  "discoveryLogs": {
    "tenders": {"label": string, "logs": [{"timestamp": string, "action": string, "result": string}]},
    "saturation": {"label": string, "logs": [...]},
    "areaSaturation": {"label": string, "logs": [...]},
    "traffic": {"label": string, "logs": [...]},
    "rental": {"label": string, "logs": [...]}
  },
  "pulseTimeline": [{"timestamp": string, "event": string, "impact": "positive"|"negative"|"neutral"}],
  "recommendations": [{
    "businessType": string,
    "category": "F&B"|"Retail"|"Wellness"|"Education"|"Services"|"Other",
    "opportunityScore": number (0-100),
    "thesis": string,
    "gapReason": string,
    "estimatedRental": number,
    "suggestedLocations": [string],
    "businessProfile": {"size": string, "targetAudience": string, "strategy": string, "employees": string},
    "financials": {"upfrontCost": number, "monthlyCost": number, "monthlyRevenueBad": number, "monthlyRevenueAvg": number, "monthlyRevenueGood": number},
    "dataSourceUrl": string
  }],
  "activeTenders": [{"block": string, "street": string, "closingDate": string, "status": string, "areaSqft": number}],
  "sources": [{"title": string, "uri": string}]
}

RULES:
1. Provide EXACTLY 3 recommendations
2. All financial values in SGD
3. If data was UNAVAILABLE from tools, use reasonable defaults and note it
4. Merge previous analysis with new findings when a knowledge base exists
5. Return ONLY valid JSON, no markdown fences
"""


def knowledge_integrator(state: MarathonState) -> dict:
    """Merge agent outputs into a coherent AreaAnalysis, respecting the knowledge base."""
    town = state["town"]
    run_id = state.get("_run_id", "")
    kb = state.get("knowledge_base")
    now = datetime.now(timezone.utc).isoformat()
    total_runs = (kb.get("total_runs", 0) if kb else 0) + 1
    logger.info("[integrator] Merging for {} — run #{}", town, total_runs)

    emit(run_id, "node_started", "knowledge_integrator")
    emit(run_id, "agent_log", "knowledge_integrator", {
        "type": "tool_start", "tool": "merge_kb",
        "message": f"Merging agent outputs for {town} (run #{total_runs})..."
    })

    # Collect all raw agent outputs
    demographics = state.get("demographics_raw", [])
    commercial = state.get("commercial_raw", [])
    market_intel = state.get("market_intel_raw", [])
    verification = state.get("verification_report", {})
    deltas = state.get("deltas", [])

    # Build context for LLM
    context_parts = [f"Town: {town}", f"Date: {now[:10]}"]

    if kb:
        context_parts.append(f"Previous analysis exists (run #{kb.get('total_runs', 0)})")
        context_parts.append(f"Previous pulse: {kb.get('current_analysis', {}).get('commercialPulse', 'N/A')}")

    for d in demographics:
        context_parts.append(f"\n=== DEMOGRAPHICS AGENT ===\n{d.get('llm_response', 'NO RESPONSE')[:3000]}")

    for c in commercial:
        context_parts.append(f"\n=== COMMERCIAL AGENT ===\n{c.get('llm_response', 'NO RESPONSE')[:3000]}")

    for m in market_intel:
        context_parts.append(f"\n=== MARKET INTEL AGENT ===\n{m.get('llm_response', 'NO RESPONSE')[:3000]}")

    context_parts.append(f"\n=== VERIFICATION REPORT ===\n{json.dumps(verification, indent=2)[:1000]}")
    context_parts.append(f"\n=== DELTAS ===\n{json.dumps(deltas, indent=2)[:1000]}")

    llm = ChatGoogleGenerativeAI(
        model="gemini-2.0-flash",
        google_api_key=settings.gemini_api_key,
    )

    emit(run_id, "agent_log", "knowledge_integrator", {
        "type": "llm_start",
        "message": f"Synthesizing AreaAnalysis with Gemini 2.0 Flash..."
    })

    response = llm.invoke([
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content="\n".join(context_parts)),
    ])

    # Parse the LLM response into AreaAnalysis
    try:
        raw_text = response.content
        # Strip markdown code fences if present
        if "```json" in raw_text:
            raw_text = raw_text.split("```json")[1].split("```")[0]
        elif "```" in raw_text:
            raw_text = raw_text.split("```")[1].split("```")[0]
        analysis = json.loads(raw_text.strip())
    except (json.JSONDecodeError, IndexError):
        # Fallback: use previous analysis if available
        if kb:
            analysis = kb.get("current_analysis", {})
            analysis["commercialPulse"] = f"[Integration error — using previous analysis] {analysis.get('commercialPulse', '')}"
        else:
            analysis = _empty_analysis(town, now)

    # Ensure required fields
    analysis["town"] = town
    analysis.setdefault("monitoringStarted", kb.get("marathon_started", now) if kb else now)
    analysis["lastScannedAt"] = now

    # Add sources from tool calls
    sources = state.get("sources", [])
    existing_sources = analysis.get("sources", [])
    all_sources = existing_sources + [{"title": s.get("title", ""), "uri": s.get("uri", "")} for s in sources if s.get("uri")]
    # Deduplicate by URI
    seen_uris = set()
    unique_sources = []
    for s in all_sources:
        if s.get("uri") and s["uri"] not in seen_uris:
            seen_uris.add(s["uri"])
            unique_sources.append(s)
    analysis["sources"] = unique_sources[:20]

    # Build updated knowledge base
    confidence = kb.get("confidence", {}) if kb else {}
    vr = state.get("verification_report", {})
    for cat, info in vr.get("categories", {}).items():
        if info.get("status") == "VERIFIED":
            confidence[cat] = min(1.0, confidence.get(cat, 0.3) + 0.1)
        elif info.get("status") == "UNAVAILABLE":
            confidence[cat] = max(0.0, confidence.get(cat, 0.3) - 0.1)

    changelog = kb.get("changelog", []) if kb else []
    for delta in deltas:
        if delta.get("significance") in ("HIGH", "MEDIUM"):
            changelog.append(delta)
    changelog = changelog[-100:]  # Cap at 100

    updated_kb = {
        "town": town,
        "marathon_started": kb.get("marathon_started", now) if kb else now,
        "total_runs": (kb.get("total_runs", 0) if kb else 0) + 1,
        "last_run_at": now,
        "current_analysis": analysis,
        "confidence": confidence,
        "changelog": changelog,
        "watch_items": kb.get("watch_items", []) if kb else [],
        "rental_history": kb.get("rental_history", []) if kb else [],
        "tender_history": kb.get("tender_history", []) if kb else [],
        "business_mix_history": kb.get("business_mix_history", []) if kb else [],
        "recommendation_history": kb.get("recommendation_history", []) if kb else [],
    }

    logger.info("[integrator] Analysis: {} chars, {} recommendations",
        len(str(analysis)), len(analysis.get("recommendations", [])))
    logger.success("[integrator] KB merged for {} — run #{}", town, updated_kb["total_runs"])

    preview = str(analysis.get("commercialPulse", ""))[:200]
    emit(run_id, "agent_log", "knowledge_integrator", {
        "type": "llm_done",
        "message": f"Analysis: {len(analysis.get('recommendations', []))} recommendations",
        "preview": preview,
    })
    emit(run_id, "node_completed", "knowledge_integrator")

    return {
        "updated_knowledge_base": updated_kb,
        "analysis": analysis,
        "run_summary": f"Run #{updated_kb['total_runs']} complete. {len(deltas)} deltas detected. "
                       f"Verification: {vr.get('verified_count', 0)} verified, {vr.get('failed_count', 0)} failed.",
    }


def _empty_analysis(town: str, now: str) -> dict:
    """Generate a minimal empty analysis structure."""
    return {
        "town": town,
        "commercialPulse": "Analysis pending — insufficient data from tools",
        "demographicsFocus": "General residential",
        "wealthMetrics": {
            "medianHouseholdIncome": "UNAVAILABLE",
            "medianHouseholdIncomePerCapita": "UNAVAILABLE",
            "privatePropertyRatio": "UNAVAILABLE",
            "wealthTier": "Mass Market",
            "sourceNote": "Data unavailable",
            "dataSourceUrl": "",
        },
        "demographicData": {
            "residentPopulation": "UNAVAILABLE",
            "planningArea": town,
            "ageDistribution": [],
            "raceDistribution": [],
            "employmentStatus": [],
            "dataSourceUrl": "",
        },
        "discoveryLogs": {
            "tenders": {"label": "HDB Tender Inventory", "logs": []},
            "saturation": {"label": "Retail Mix Saturation", "logs": []},
            "areaSaturation": {"label": "Area Saturation Analysis", "logs": []},
            "traffic": {"label": "Foot Traffic Proxies", "logs": []},
            "rental": {"label": "Rental Yield Potential", "logs": []},
        },
        "pulseTimeline": [],
        "recommendations": [],
        "activeTenders": [],
        "sources": [],
        "monitoringStarted": now,
        "lastScannedAt": now,
    }
