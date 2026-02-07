from datetime import datetime, timezone

from app.models.state import MarathonState


def marathon_observer(state: MarathonState) -> dict:
    """Load KB, determine what to investigate this run.

    - If no KB exists: cold start, run everything
    - Demographics: re-check weekly (slow-moving)
    - Tenders: always re-check (fast-moving)
    - Rental: re-check weekly
    - Business mix: re-check every 3 days
    - Prioritize watch_items
    """
    kb = state.get("knowledge_base")
    now = datetime.now(timezone.utc)

    if not kb:
        return {
            "research_directive": {
                "scope": "full",
                "reason": "cold_start",
                "categories": ["demographics", "tenders", "rental", "market_intel"],
                "timestamp": now.isoformat(),
            }
        }

    last_run = kb.get("last_run_at", "")
    try:
        last_dt = datetime.fromisoformat(last_run)
    except (ValueError, TypeError):
        last_dt = datetime.min.replace(tzinfo=timezone.utc)

    days_since = (now - last_dt).days if last_dt.tzinfo else 999

    categories = []
    reasons = []

    # Tenders: always check (fast-moving data)
    categories.append("tenders")
    reasons.append("tenders: always checked")

    # Demographics: weekly
    if days_since >= 7:
        categories.append("demographics")
        reasons.append(f"demographics: {days_since}d stale (threshold: 7d)")

    # Rental: weekly
    if days_since >= 7:
        categories.append("rental")
        reasons.append(f"rental: {days_since}d stale (threshold: 7d)")

    # Business mix: every 3 days
    if days_since >= 3:
        categories.append("market_intel")
        reasons.append(f"market_intel: {days_since}d stale (threshold: 3d)")

    # Watch items: always prioritize
    watch_items = kb.get("watch_items", [])
    if watch_items:
        reasons.append(f"watch_items: {len(watch_items)} active")

    scope = "full" if len(categories) >= 3 else "partial"

    return {
        "research_directive": {
            "scope": scope,
            "reason": "; ".join(reasons),
            "categories": categories,
            "watch_items": watch_items,
            "days_since_last_run": days_since,
            "timestamp": now.isoformat(),
        }
    }
