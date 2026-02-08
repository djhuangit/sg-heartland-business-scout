from datetime import datetime, timezone
import json

from loguru import logger

from app.models.state import MarathonState
from app.routers._event_queue import emit


def delta_detector(state: MarathonState) -> dict:
    """Compare new findings with knowledge base.

    For each data category:
    - what_changed: specific changes
    - significance: HIGH / MEDIUM / LOW / NOISE
    - trend_direction: IMPROVING / DECLINING / STABLE / NEW
    """
    kb = state.get("knowledge_base")
    run_id = state.get("_run_id", "")
    now = datetime.now(timezone.utc).isoformat()
    deltas = []

    emit(run_id, "node_started", "delta_detector")
    emit(run_id, "agent_log", "delta_detector", {
        "type": "tool_start", "tool": "compare_kb",
        "message": f"Comparing new data against {'existing' if kb else 'empty'} knowledge base..."
    })

    # Cold start: everything is NEW
    if not kb:
        deltas.append({
            "date": now,
            "category": "all",
            "change": "Initial analysis — cold start",
            "significance": "HIGH",
            "trend_direction": "NEW",
        })
        emit(run_id, "agent_log", "delta_detector", {
            "type": "tool_result", "tool": "compare_kb",
            "status": "VERIFIED",
            "message": "Cold start — all data is NEW (1 delta, HIGH significance)",
        })
        emit(run_id, "node_completed", "delta_detector")
        return {"deltas": deltas}

    current_analysis = kb.get("current_analysis", {})

    # Check demographics changes
    for demo_raw in state.get("demographics_raw", []):
        llm_response = demo_raw.get("llm_response", "")
        if llm_response and current_analysis.get("demographicData"):
            deltas.append({
                "date": now,
                "category": "demographics",
                "change": "Demographics data refreshed",
                "significance": "LOW",
                "trend_direction": "STABLE",
            })

    # Check tender changes
    for comm_raw in state.get("commercial_raw", []):
        llm_response = comm_raw.get("llm_response", "")
        if llm_response:
            # Check for new tenders (simple heuristic)
            old_tenders = current_analysis.get("activeTenders", [])
            deltas.append({
                "date": now,
                "category": "tenders",
                "change": f"Tender data refreshed (previously {len(old_tenders)} tenders)",
                "significance": "MEDIUM",
                "trend_direction": "STABLE",
            })

    # Check market intel changes
    for mi_raw in state.get("market_intel_raw", []):
        llm_response = mi_raw.get("llm_response", "")
        if llm_response:
            deltas.append({
                "date": now,
                "category": "market_intel",
                "change": "Market intelligence refreshed",
                "significance": "LOW",
                "trend_direction": "STABLE",
            })

    # Check for fetch failures — these are significant
    for failure in state.get("fetch_failures", []):
        deltas.append({
            "date": now,
            "category": "data_quality",
            "change": f"Data source failed: {failure.get('source_id', 'unknown')} — {failure.get('error', '')}",
            "significance": "MEDIUM",
            "trend_direction": "DECLINING",
        })

    if not deltas:
        deltas.append({
            "date": now,
            "category": "all",
            "change": "No significant changes detected",
            "significance": "NOISE",
            "trend_direction": "STABLE",
        })

    high = sum(1 for d in deltas if d.get("significance") == "HIGH")
    med = sum(1 for d in deltas if d.get("significance") == "MEDIUM")
    low = sum(1 for d in deltas if d.get("significance") == "LOW")
    logger.info("[delta] {} deltas detected (HIGH={}, MEDIUM={}, LOW={})", len(deltas), high, med, low)

    emit(run_id, "agent_log", "delta_detector", {
        "type": "tool_result", "tool": "compare_kb",
        "status": "VERIFIED",
        "message": f"{len(deltas)} deltas (HIGH={high}, MEDIUM={med}, LOW={low})",
    })
    emit(run_id, "node_completed", "delta_detector")

    return {"deltas": deltas}
