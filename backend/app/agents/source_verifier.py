from datetime import datetime, timezone

from app.models.state import ScoutState


def source_verifier(state: ScoutState) -> dict:
    """Cross-reference agent claims against actual tool call results.

    - Identifies which tool calls FAILED
    - Tags data categories with verification status
    - Produces verification_report and fetch_failures list
    """
    tool_calls = state.get("tool_calls", [])
    now = datetime.now(timezone.utc).isoformat()

    failed_tools = []
    verified_tools = []
    verification_report = {
        "timestamp": now,
        "total_tool_calls": len(tool_calls),
        "verified_count": 0,
        "failed_count": 0,
        "categories": {},
    }

    for tc in tool_calls:
        source_id = tc.get("source_id", "unknown")
        fetch_status = tc.get("fetch_status", "UNAVAILABLE")

        if fetch_status == "UNAVAILABLE":
            failed_tools.append({
                "source_id": source_id,
                "error": tc.get("error", "unknown"),
                "raw_url": tc.get("raw_url"),
                "timestamp": now,
            })
            verification_report["failed_count"] += 1
        else:
            verified_tools.append(source_id)
            verification_report["verified_count"] += 1

        # Categorize by data domain
        if "singstat" in source_id:
            cat = "demographics"
        elif "hdb" in source_id:
            cat = "tenders"
        elif "ura" in source_id:
            cat = "rental"
        elif "web_search" in source_id:
            cat = "web_search"
        else:
            cat = "other"

        if cat not in verification_report["categories"]:
            verification_report["categories"][cat] = {
                "status": fetch_status,
                "sources": [],
            }

        verification_report["categories"][cat]["sources"].append({
            "source_id": source_id,
            "status": fetch_status,
            "error": tc.get("error"),
        })

        # If any source in a category failed, mark the category accordingly
        if fetch_status == "UNAVAILABLE":
            verification_report["categories"][cat]["status"] = "UNAVAILABLE"

    return {
        "verification_report": verification_report,
        "fetch_failures": failed_tools,
    }
