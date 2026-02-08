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
from app.routers._event_queue import create_queue, remove_queue

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
        q = create_queue(run_id)
        directive = "cold_start"

        try:
            logger.info("Scout stream started for {} (run {})", town, run_id[:8])
            yield {"event": "message", "data": _emit_event("run_started", "marathon", {"town": town, "run_id": run_id})}

            kb = _knowledge_bases.get(town)
            directive = "cold_start" if not kb else "incremental"

            # Prepare initial state with _run_id for live event emitting
            initial_state = {
                "town": town,
                "_run_id": run_id,
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

            # Run pipeline in background — agents push events to queue in real-time
            pipeline_done = asyncio.Event()
            pipeline_result = {}
            pipeline_error = None

            async def run_pipeline():
                nonlocal pipeline_result, pipeline_error
                try:
                    pipeline_result = await asyncio.to_thread(marathon_graph.invoke, initial_state)
                except Exception as exc:
                    pipeline_error = exc
                finally:
                    pipeline_done.set()

            asyncio.create_task(run_pipeline())

            # Stream events from queue until pipeline completes
            while not pipeline_done.is_set():
                try:
                    event = await asyncio.to_thread(q.get, timeout=0.5)
                    yield {"event": "message", "data": json.dumps(event)}
                except Exception:
                    pass  # Queue empty, loop again

            # Drain remaining events from queue
            while not q.empty():
                try:
                    event = q.get_nowait()
                    yield {"event": "message", "data": json.dumps(event)}
                except Exception:
                    break

            remove_queue(run_id)

            # Check for pipeline error
            if pipeline_error:
                raise pipeline_error

            result = pipeline_result

            # Persist KB
            updated_kb = result.get("updated_knowledge_base")
            if updated_kb:
                _knowledge_bases[town] = updated_kb

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

            # Final completion event
            yield {"event": "message", "data": _emit_event("run_completed", "marathon", {
                "run_summary": result.get("run_summary", ""),
                "town": town,
                "run_id": run_id,
                "duration_ms": duration_ms,
            })}

        except Exception as e:
            logger.exception("Scout stream failed for {}", town)
            remove_queue(run_id)
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
