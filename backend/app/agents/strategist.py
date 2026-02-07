import json
from datetime import datetime, timezone

from loguru import logger
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage

from app.config import settings
from app.models.state import MarathonState

SYSTEM_PROMPT = """You are a strategic investment advisor for Singapore HDB heartlands.
You are called ONLY when significant changes have been detected in the market.

Given the current analysis and the changes detected, update the recommendations
to reflect the new reality. You should:

1. Review existing recommendations against the changes
2. Adjust opportunity scores if warranted
3. Add new recommendations if new opportunities emerged
4. Keep recommendations that are still valid
5. Provide EXACTLY 3 recommendations total

Return a JSON array of 3 recommendation objects, each with:
{
  "businessType": string,
  "category": "F&B"|"Retail"|"Wellness"|"Education"|"Services"|"Other",
  "opportunityScore": number (0-100),
  "thesis": string,
  "gapReason": string,
  "estimatedRental": number,
  "suggestedLocations": [string],
  "businessProfile": {"size": string, "targetAudience": string, "strategy": string, "employees": string},
  "financials": {"upfrontCost": number, "monthlyCost": number, "monthlyRevenueBad": number, "monthlyRevenueAvg": number, "monthlyRevenueGood": number},
  "dataSourceUrl": string
}

Return ONLY valid JSON array, no markdown fences.
"""


def strategist(state: MarathonState) -> dict:
    """Re-evaluate recommendations based on significant changes.
    Only called when delta_detector found HIGH significance changes."""
    analysis = state.get("analysis", {})
    deltas = state.get("deltas", [])
    now = datetime.now(timezone.utc).isoformat()

    high_deltas = [d for d in deltas if d.get("significance") == "HIGH"]
    logger.info("[strategist] Re-evaluating due to {} HIGH changes", len(high_deltas))

    llm = ChatGoogleGenerativeAI(
        model="gemini-2.0-flash",
        google_api_key=settings.gemini_api_key,
    )

    context = f"""Town: {analysis.get('town', 'Unknown')}
Current pulse: {analysis.get('commercialPulse', 'N/A')}
Wealth tier: {analysis.get('wealthMetrics', {}).get('wealthTier', 'N/A')}
Population: {analysis.get('demographicData', {}).get('residentPopulation', 'N/A')}

SIGNIFICANT CHANGES DETECTED:
{json.dumps(high_deltas, indent=2)}

CURRENT RECOMMENDATIONS:
{json.dumps(analysis.get('recommendations', []), indent=2)[:3000]}

Please provide updated recommendations reflecting these changes."""

    response = llm.invoke([
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=context),
    ])

    try:
        raw_text = response.content
        if "```json" in raw_text:
            raw_text = raw_text.split("```json")[1].split("```")[0]
        elif "```" in raw_text:
            raw_text = raw_text.split("```")[1].split("```")[0]
        new_recs = json.loads(raw_text.strip())
        if isinstance(new_recs, list):
            analysis["recommendations"] = new_recs[:3]
    except (json.JSONDecodeError, IndexError):
        # Keep existing recommendations on parse failure
        pass

    # Add pulse event for the strategy update
    timeline = analysis.get("pulseTimeline", [])
    timeline.insert(0, {
        "timestamp": now,
        "event": f"Strategy re-evaluated due to {len(high_deltas)} significant change(s)",
        "impact": "positive",
    })
    analysis["pulseTimeline"] = timeline[:100]
    logger.success("[strategist] Updated {} recommendations", len(analysis.get("recommendations", [])))

    return {
        "analysis": analysis,
        "run_summary": state.get("run_summary", "") + f" Strategist updated {len(analysis.get('recommendations', []))} recommendations.",
    }
