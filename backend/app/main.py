import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from loguru import logger
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.logging_config import setup_logging
from app.routers import scout
from app.graphs.marathon_graph import marathon_graph
from app.routers.scout import HDB_TOWNS, _knowledge_bases, _run_history

setup_logging()

scheduler = AsyncIOScheduler()


async def daily_marathon():
    """Run marathon for all towns sequentially."""
    logger.info("Starting daily marathon sweep for {} towns", len(HDB_TOWNS))
    for town in HDB_TOWNS:
        run_id = str(uuid.uuid4())
        started_at = datetime.now(timezone.utc).isoformat()
        start_time = time.monotonic()
        kb = _knowledge_bases.get(town)
        directive = "cold_start" if not kb else "incremental"
        try:
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
            result = await asyncio.to_thread(marathon_graph.invoke, initial_state)
            updated_kb = result.get("updated_knowledge_base")
            if updated_kb:
                _knowledge_bases[town] = updated_kb
            completed_at = datetime.now(timezone.utc).isoformat()
            duration_ms = int((time.monotonic() - start_time) * 1000)
            _run_history.append({
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
            })
            logger.success("Marathon complete for {} — {}ms", town, duration_ms)
        except Exception as e:
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
            logger.error("Marathon failed for {}: {}", town, e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.add_job(daily_marathon, "cron", hour=6, minute=0, id="daily_marathon")
    scheduler.start()
    logger.info("Scheduler started — daily marathon at 06:00")
    yield
    scheduler.shutdown()


app = FastAPI(title="Heartland Scout SG — Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scout.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/marathon/trigger")
async def trigger_full_marathon():
    """Manually trigger a marathon sweep for all towns."""
    asyncio.create_task(daily_marathon())
    return {"status": "marathon_triggered", "towns": len(HDB_TOWNS)}
