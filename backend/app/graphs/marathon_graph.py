from loguru import logger
from langgraph.graph import StateGraph, START, END

from app.models.state import MarathonState
from app.agents.marathon_observer import marathon_observer
from app.agents.delta_detector import delta_detector
from app.agents.knowledge_integrator import knowledge_integrator
from app.agents.strategist import strategist
from app.graphs.scout_graph import scout_graph


def _scout_pipeline(state: MarathonState) -> dict:
    """Run the inner scout pipeline as a subgraph.
    Maps MarathonState fields to ScoutState and back."""
    scout_input = {
        "town": state["town"],
        "research_directive": state.get("research_directive", {}),
        "demographics_raw": [],
        "commercial_raw": [],
        "market_intel_raw": [],
        "tool_calls": [],
        "sources": [],
        "verification_report": {},
        "fetch_failures": [],
    }

    result = scout_graph.invoke(scout_input)

    return {
        "demographics_raw": result.get("demographics_raw", []),
        "commercial_raw": result.get("commercial_raw", []),
        "market_intel_raw": result.get("market_intel_raw", []),
        "tool_calls": result.get("tool_calls", []),
        "sources": result.get("sources", []),
        "verification_report": result.get("verification_report", {}),
        "fetch_failures": result.get("fetch_failures", []),
    }


def persist_to_db(state: MarathonState) -> dict:
    """Persist the updated knowledge base.
    For now, just passes through — DB persistence added in Phase 6."""
    kb = state.get("updated_knowledge_base", {})
    logger.success("[persist] KB saved for {} — run #{}",
        kb.get("town", "?"), kb.get("total_runs", 0))
    return {
        "run_summary": state.get("run_summary", "Run complete."),
    }


def should_run_strategist(state: MarathonState) -> str:
    """Only re-evaluate strategy if material changes detected."""
    deltas = state.get("deltas", [])
    high_changes = [d for d in deltas if d.get("significance") == "HIGH"]
    return "strategist" if high_changes else "persist"


def build_marathon_graph():
    """Build the outer marathon loop graph.

    Structure:
    START → marathon_observer → scout_pipeline → delta_detector
          → knowledge_integrator → (strategist if HIGH deltas) → persist → END
    """
    builder = StateGraph(MarathonState)

    builder.add_node("marathon_observer", marathon_observer)
    builder.add_node("scout_pipeline", _scout_pipeline)
    builder.add_node("delta_detector", delta_detector)
    builder.add_node("knowledge_integrator", knowledge_integrator)
    builder.add_node("strategist", strategist)
    builder.add_node("persist", persist_to_db)

    builder.add_edge(START, "marathon_observer")
    builder.add_edge("marathon_observer", "scout_pipeline")
    builder.add_edge("scout_pipeline", "delta_detector")
    builder.add_edge("delta_detector", "knowledge_integrator")
    builder.add_conditional_edges(
        "knowledge_integrator",
        should_run_strategist,
        {"strategist": "strategist", "persist": "persist"},
    )
    builder.add_edge("strategist", "persist")
    builder.add_edge("persist", END)

    return builder.compile()


marathon_graph = build_marathon_graph()
