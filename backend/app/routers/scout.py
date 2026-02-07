import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from sse_starlette.sse import EventSourceResponse

from app.graphs.marathon_graph import marathon_graph
from app.graphs.dossier_graph import generate_dossier

logger = logging.getLogger(__name__)

router = APIRouter()

# In-memory store for knowledge bases (will move to Postgres when Docker is available)
_knowledge_bases: dict[str, dict] = {}
_active_runs: dict[str, dict] = {}

HDB_TOWNS = [
    'Ang Mo Kio', 'Bedok', 'Bishan', 'Bukit Batok', 'Bukit Merah',
    'Bukit Panjang', 'Bukit Timah', 'Central Area', 'Choa Chu Kang',
    'Clementi', 'Geylang', 'Hougang', 'Jurong East', 'Jurong West',
    'Kallang/Whampoa', 'Lim Chu Kang', 'Marine Parade', 'Pasir Ris',
    'Punggol', 'Queenstown', 'Sembawang', 'Sengkang', 'Serangoon',
    'Tampines', 'Toa Payoh', 'Woodlands', 'Yishun',
]


def _emit_event(event_type: str, node: str, detail: dict = None) -> str:
    """Create a SSE-compatible JSON event."""
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event_type": event_type,
        "node": node,
        "detail": detail or {},
    }
    return json.dumps(event)


@router.get("/scout/{town}/stream")
async def stream_scout(town: str):
    """SSE stream that runs the marathon pipeline and emits workflow events."""
    if town not in HDB_TOWNS:
        raise HTTPException(status_code=404, detail=f"Unknown town: {town}")

    async def event_generator():
        try:
            yield {"event": "message", "data": _emit_event("run_started", "marathon", {"town": town})}

            kb = _knowledge_bases.get(town)

            # Step 1: Marathon Observer
            yield {"event": "message", "data": _emit_event("node_started", "marathon_observer")}
            await asyncio.sleep(0.1)

            # Prepare initial state
            initial_state = {
                "town": town,
                "knowledge_base": kb,
                "research_directive": {},
                "demographics_raw": [],
                "commercial_raw": [],
                "market_intel_raw": [],
                "tool_calls": [],
                "sources": [],
                "verification_report": {},
                "fetch_failures": [],
                "deltas": [],
                "updated_knowledge_base": None,
                "analysis": None,
                "run_summary": "",
            }

            # Run the full marathon graph in a thread (blocking LangGraph call)
            # We emit simulated progress events to show the pipeline stages
            yield {"event": "message", "data": _emit_event("node_completed", "marathon_observer",
                {"directive": "cold_start" if not kb else "incremental"})}

            # Emit node_started for the parallel agents
            yield {"event": "message", "data": _emit_event("node_started", "demographics_agent")}
            yield {"event": "message", "data": _emit_event("node_started", "commercial_agent")}
            yield {"event": "message", "data": _emit_event("node_started", "market_intel_agent")}

            # Run the full pipeline
            result = await asyncio.to_thread(marathon_graph.invoke, initial_state)

            # Emit tool results from the verification report
            tool_calls = result.get("tool_calls", [])
            for tc in tool_calls:
                source = tc.get("source_id", "unknown")
                status = tc.get("fetch_status", "UNAVAILABLE")
                error = tc.get("error")

                # Determine which agent this belongs to
                if "singstat" in source:
                    node = "demographics_agent"
                elif "hdb" in source:
                    node = "commercial_agent"
                elif "ura" in source:
                    node = "commercial_agent"
                else:
                    node = "market_intel_agent"

                yield {"event": "message", "data": _emit_event("tool_result", node, {
                    "tool": source,
                    "status": status,
                    "error": error,
                    "url": tc.get("raw_url"),
                })}
                await asyncio.sleep(0.05)

            # Emit agent completions
            yield {"event": "message", "data": _emit_event("node_completed", "demographics_agent")}
            yield {"event": "message", "data": _emit_event("node_completed", "commercial_agent")}
            yield {"event": "message", "data": _emit_event("node_completed", "market_intel_agent")}

            # Source verifier
            yield {"event": "message", "data": _emit_event("node_started", "source_verifier")}
            vr = result.get("verification_report", {})
            for cat, info in vr.get("categories", {}).items():
                if info.get("status") == "UNAVAILABLE":
                    yield {"event": "message", "data": _emit_event("verification_flag", "source_verifier", {
                        "category": cat,
                        "status": "UNAVAILABLE",
                        "sources": info.get("sources", []),
                    })}
            yield {"event": "message", "data": _emit_event("node_completed", "source_verifier", {
                "verified": vr.get("verified_count", 0),
                "failed": vr.get("failed_count", 0),
            })}

            # Delta detector
            yield {"event": "message", "data": _emit_event("node_started", "delta_detector")}
            deltas = result.get("deltas", [])
            for delta in deltas:
                yield {"event": "message", "data": _emit_event("delta_detected", "delta_detector", delta)}
                await asyncio.sleep(0.05)
            yield {"event": "message", "data": _emit_event("node_completed", "delta_detector",
                {"count": len(deltas)})}

            # Knowledge integrator
            yield {"event": "message", "data": _emit_event("node_started", "knowledge_integrator")}
            yield {"event": "message", "data": _emit_event("node_completed", "knowledge_integrator")}

            # Strategist (conditional)
            high_deltas = [d for d in deltas if d.get("significance") == "HIGH"]
            if high_deltas:
                yield {"event": "message", "data": _emit_event("node_started", "strategist")}
                yield {"event": "message", "data": _emit_event("node_completed", "strategist",
                    {"reason": f"{len(high_deltas)} HIGH significance changes"})}
            else:
                yield {"event": "message", "data": _emit_event("node_started", "strategist",
                    {"status": "skipped", "reason": "No HIGH significance changes"})}

            # Persist
            yield {"event": "message", "data": _emit_event("node_started", "persist")}
            updated_kb = result.get("updated_knowledge_base")
            if updated_kb:
                _knowledge_bases[town] = updated_kb
            yield {"event": "message", "data": _emit_event("node_completed", "persist")}

            # Final
            yield {"event": "message", "data": _emit_event("run_completed", "marathon", {
                "run_summary": result.get("run_summary", ""),
                "town": town,
            })}

        except Exception as e:
            logger.exception(f"Marathon failed for {town}")
            yield {"event": "message", "data": _emit_event("run_failed", "marathon", {
                "error": str(e),
            })}

    return EventSourceResponse(event_generator())


@router.get("/scout/{town}/analysis")
async def get_analysis(town: str):
    """Get the latest analysis for a town from the knowledge base."""
    kb = _knowledge_bases.get(town)
    if not kb:
        raise HTTPException(status_code=404, detail=f"No analysis found for {town}. Run a scout first.")
    return kb.get("current_analysis", {})


@router.get("/scout/{town}/knowledge-base")
async def get_knowledge_base(town: str):
    """Get the full knowledge base for a town."""
    kb = _knowledge_bases.get(town)
    if not kb:
        raise HTTPException(status_code=404, detail=f"No knowledge base for {town}")
    return kb


@router.get("/scout/{town}/changelog")
async def get_changelog(town: str):
    """Get the change history for a town."""
    kb = _knowledge_bases.get(town)
    if not kb:
        return {"changelog": []}
    return {"changelog": kb.get("changelog", [])}


@router.post("/dossier/{town}")
async def create_dossier(town: str, business_type: str = Query(...)):
    """Generate a custom dossier for a specific business type."""
    kb = _knowledge_bases.get(town)
    if not kb:
        raise HTTPException(status_code=404, detail=f"No analysis for {town}. Run a scout first.")
    analysis = kb.get("current_analysis", {})
    recommendation = await generate_dossier(town, business_type, analysis)
    return recommendation


@router.get("/towns")
async def list_towns():
    """List all available HDB towns and their analysis status."""
    return {
        "towns": [
            {
                "name": t,
                "has_analysis": t in _knowledge_bases,
                "total_runs": _knowledge_bases.get(t, {}).get("total_runs", 0),
                "last_run_at": _knowledge_bases.get(t, {}).get("last_run_at"),
            }
            for t in HDB_TOWNS
        ]
    }
