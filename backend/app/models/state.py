from __future__ import annotations

from typing import Optional, Annotated
from typing_extensions import TypedDict
import operator


class ScoutState(TypedDict):
    """Per-run state flowing through the scout pipeline."""
    town: str
    research_directive: dict

    # Parallel agent raw outputs (reducers for fan-in)
    demographics_raw: Annotated[list, operator.add]
    commercial_raw: Annotated[list, operator.add]
    market_intel_raw: Annotated[list, operator.add]

    # Tool call log (every tool invocation recorded)
    tool_calls: Annotated[list, operator.add]
    sources: Annotated[list, operator.add]

    # Source verification output
    verification_report: dict
    fetch_failures: Annotated[list, operator.add]


class MarathonState(TypedDict):
    """Full marathon run state."""
    town: str
    knowledge_base: Optional[dict]
    research_directive: dict

    # Inherited from ScoutState after inner graph
    demographics_raw: Annotated[list, operator.add]
    commercial_raw: Annotated[list, operator.add]
    market_intel_raw: Annotated[list, operator.add]
    tool_calls: Annotated[list, operator.add]
    sources: Annotated[list, operator.add]

    # Verification
    verification_report: dict
    fetch_failures: Annotated[list, operator.add]

    # Delta detection
    deltas: list

    # Output
    updated_knowledge_base: Optional[dict]
    analysis: Optional[dict]
    run_summary: str
