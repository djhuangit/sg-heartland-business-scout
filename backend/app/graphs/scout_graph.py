from langgraph.graph import StateGraph, START, END
from app.models.state import ScoutState
from app.agents.demographics import demographics_agent
from app.agents.commercial import commercial_agent
from app.agents.market_intel import market_intel_agent
from app.agents.source_verifier import source_verifier


def build_scout_graph() -> StateGraph:
    """Build the inner scout pipeline graph.

    Structure:
    START → [demographics_agent, commercial_agent, market_intel_agent] → source_verifier → END

    The three agents run in parallel (fan-out), then results
    fan-in to the source verifier which cross-checks claims.
    """
    builder = StateGraph(ScoutState)

    builder.add_node("demographics_agent", demographics_agent)
    builder.add_node("commercial_agent", commercial_agent)
    builder.add_node("market_intel_agent", market_intel_agent)
    builder.add_node("source_verifier", source_verifier)

    # Fan-out: parallel execution from START
    builder.add_edge(START, "demographics_agent")
    builder.add_edge(START, "commercial_agent")
    builder.add_edge(START, "market_intel_agent")

    # Fan-in: all agents feed to source verifier
    builder.add_edge("demographics_agent", "source_verifier")
    builder.add_edge("commercial_agent", "source_verifier")
    builder.add_edge("market_intel_agent", "source_verifier")

    builder.add_edge("source_verifier", END)

    return builder.compile()


scout_graph = build_scout_graph()
