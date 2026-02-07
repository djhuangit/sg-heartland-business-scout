from datetime import datetime, timezone

import httpx
from langchain_core.tools import tool


@tool
def search_web(query: str) -> dict:
    """Search the web for information about Singapore commercial real estate, demographics, or business data.
    Uses Google Custom Search API or falls back to direct URL fetch."""
    result = {
        "fetch_status": "UNAVAILABLE",
        "source_id": "web_search",
        "data": None,
        "raw_url": None,
        "error": None,
        "fetched_at": None,
        "query": query,
    }
    try:
        # Use a search-oriented approach: fetch Google search results page
        # In production, replace with Tavily/SerpAPI/Google Custom Search
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; HeartlandScout/1.0)"
        }
        search_url = f"https://www.google.com/search?q={query}"
        response = httpx.get(
            search_url,
            headers=headers,
            timeout=15,
            follow_redirects=True,
        )
        response.raise_for_status()
        result["fetch_status"] = "VERIFIED"
        result["data"] = response.text[:5000]  # Truncate for context window
        result["raw_url"] = search_url
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    except httpx.TimeoutException:
        result["error"] = "timeout_15s"
    except httpx.HTTPStatusError as e:
        result["error"] = f"http_{e.response.status_code}"
    except Exception as e:
        result["error"] = str(e)
    return result
