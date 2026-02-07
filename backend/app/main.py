import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.routers import scout
from app.graphs.marathon_graph import marathon_graph
from app.routers.scout import HDB_TOWNS, _knowledge_bases

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


async def daily_marathon():
    """Run marathon for all towns sequentially."""
    logger.info("Starting daily marathon sweep for %d towns", len(HDB_TOWNS))
    for town in HDB_TOWNS:
        try:
            kb = _knowledge_bases.get(town)
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
            logger.info("Marathon complete for %s", town)
        except Exception as e:
            logger.error("Marathon failed for %s: %s", town, e)


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
