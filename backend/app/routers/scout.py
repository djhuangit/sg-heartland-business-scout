import asyncio
import json
import time
import uuid
from datetime import datetime, timezone

from loguru import logger
from fastapi import APIRouter, HTTPException, Query
from sse_starlette.sse import EventSourceResponse

from app.graphs.marathon_graph import marathon_graph
from app.graphs.dossier_graph import generate_dossier

router = APIRouter()

# In-memory store for knowledge bases (will move to Postgres when Docker is available)
_knowledge_bases: dict[str, dict] = {}
_run_history: list[dict] = []  # Append-only list of all runs

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
        run_id = str(uuid.uuid4())
        started_at = datetime.now(timezone.utc).isoformat()
        start_time = time.monotonic()

        try:
            logger.info("Scout stream started for {} (run {})", town, run_id[:8])
            yield {"event": "message", "data": _emit_event("run_started", "marathon", {"town": town, "run_id": run_id})}

            kb = _knowledge_bases.get(town)
            directive = "cold_start" if not kb else "incremental"
            logger.info("Marathon observer: {}", directive)

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
            logger.info("Pipeline running for {} ...", town)
            result = await asyncio.to_thread(marathon_graph.invoke, initial_state)

            # Emit tool results from the verification report
            tool_calls = result.get("tool_calls", [])
            deltas = result.get("deltas", [])
            logger.info("Pipeline complete — {} tool calls, {} deltas", len(tool_calls), len(deltas))
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

            # Record run history
            completed_at = datetime.now(timezone.utc).isoformat()
            duration_ms = int((time.monotonic() - start_time) * 1000)
            run_record = {
                "run_id": run_id,
                "town": town,
                "started_at": started_at,
                "completed_at": completed_at,
                "status": "completed",
                "run_number": updated_kb.get("total_runs", 0) if updated_kb else 0,
                "run_summary": result.get("run_summary", ""),
                "directive": directive,
                "tool_calls": result.get("tool_calls", []),
                "verification_report": result.get("verification_report", {}),
                "fetch_failures": result.get("fetch_failures", []),
                "deltas": result.get("deltas", []),
                "analysis": updated_kb.get("current_analysis", {}) if updated_kb else {},
                "duration_ms": duration_ms,
            }
            _run_history.append(run_record)
            logger.success("Run {} persisted — {}ms", run_id[:8], duration_ms)

            # Final
            yield {"event": "message", "data": _emit_event("run_completed", "marathon", {
                "run_summary": result.get("run_summary", ""),
                "town": town,
                "run_id": run_id,
                "duration_ms": duration_ms,
            })}

        except Exception as e:
            logger.exception("Scout stream failed for {}", town)
            completed_at = datetime.now(timezone.utc).isoformat()
            duration_ms = int((time.monotonic() - start_time) * 1000)
            _run_history.append({
                "run_id": run_id,
                "town": town,
                "started_at": started_at,
                "completed_at": completed_at,
                "status": "failed",
                "run_number": 0,
                "run_summary": "",
                "directive": directive,
                "tool_calls": [],
                "verification_report": {},
                "fetch_failures": [],
                "deltas": [],
                "analysis": {},
                "duration_ms": duration_ms,
                "error": str(e),
            })
            yield {"event": "message", "data": _emit_event("run_failed", "marathon", {
                "error": str(e),
                "run_id": run_id,
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


@router.delete("/scout/{town}/cache")
async def clear_town_cache(town: str):
    """Clear knowledge base and run history for a town."""
    global _run_history
    removed = _knowledge_bases.pop(town, None)
    _run_history = [r for r in _run_history if r["town"] != town]
    logger.info("Cache cleared for {} (had_kb={})", town, removed is not None)
    return {"cleared": town, "had_knowledge_base": removed is not None}


@router.post("/dossier/{town}")
async def create_dossier(town: str, business_type: str = Query(...)):
    """Generate a custom dossier for a specific business type."""
    kb = _knowledge_bases.get(town)
    if not kb:
        raise HTTPException(status_code=404, detail=f"No analysis for {town}. Run a scout first.")
    analysis = kb.get("current_analysis", {})
    recommendation = await generate_dossier(town, business_type, analysis)
    return recommendation


@router.get("/runs")
async def list_runs(town: str = Query(None), limit: int = Query(50)):
    """List past pipeline runs, newest first."""
    runs = _run_history
    if town:
        runs = [r for r in runs if r["town"] == town]
    summaries = [
        {
            "run_id": r["run_id"],
            "town": r["town"],
            "started_at": r["started_at"],
            "completed_at": r["completed_at"],
            "status": r["status"],
            "run_number": r.get("run_number", 0),
            "run_summary": r.get("run_summary", ""),
            "directive": r.get("directive", ""),
            "duration_ms": r.get("duration_ms", 0),
            "tool_call_count": len(r.get("tool_calls", [])),
            "delta_count": len(r.get("deltas", [])),
            "verified_count": r.get("verification_report", {}).get("verified_count", 0),
            "failed_count": r.get("verification_report", {}).get("failed_count", 0),
        }
        for r in reversed(runs)
    ][:limit]
    return {"runs": summaries, "total": len(runs)}


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    """Get full details for a specific run."""
    for r in _run_history:
        if r["run_id"] == run_id:
            return r
    raise HTTPException(status_code=404, detail=f"Run {run_id} not found")


def _town_summary_metrics(town: str) -> dict:
    """Extract summary metrics from the knowledge base for the landing page."""
    kb = _knowledge_bases.get(town)
    if not kb:
        return {}
    analysis = kb.get("current_analysis", {})
    recs = analysis.get("recommendations", [])
    return {
        "wealth_tier": analysis.get("wealthMetrics", {}).get("wealthTier"),
        "population": analysis.get("demographicData", {}).get("residentPopulation"),
        "recommendation_count": len(recs),
        "top_opportunity_score": max((r.get("opportunityScore", 0) for r in recs), default=None),
        "commercial_pulse": analysis.get("commercialPulse"),
    }


@router.get("/towns")
async def list_towns():
    """List all available HDB towns and their analysis status."""
    return {
        "towns": [
            {
                "name": t,
                "has_analysis": t in _knowledge_bases,
                "total_runs": len([r for r in _run_history if r["town"] == t]),
                "last_run_at": next(
                    (r["completed_at"] for r in reversed(_run_history) if r["town"] == t),
                    None,
                ),
                **_town_summary_metrics(t),
            }
            for t in HDB_TOWNS
        ]
    }
