import json
from datetime import datetime, timezone

from loguru import logger
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage

from app.config import settings
from app.tools.web_search import search_web

DOSSIER_PROMPT = """Generate a SINGLE "Strategic Investment Dossier" for a "{business_type}" in "{town}", Singapore.

CONTEXT:
- Wealth Tier: {wealth_tier}
- Median Income: {median_income}
- Population: {population}

REQUIREMENTS:
- Create a realistic business plan
- Provide financials in SGD
- Classify correctly (F&B, Retail, Wellness, Education, Services, Other)
- Provide a dataSourceUrl for a relevant benchmark

Return ONLY a single JSON object with this structure:
{{
  "businessType": string,
  "category": string,
  "opportunityScore": number (0-100),
  "thesis": string,
  "gapReason": string,
  "estimatedRental": number,
  "suggestedLocations": [string],
  "businessProfile": {{"size": string, "targetAudience": string, "strategy": string, "employees": string}},
  "financials": {{"upfrontCost": number, "monthlyCost": number, "monthlyRevenueBad": number, "monthlyRevenueAvg": number, "monthlyRevenueGood": number}},
  "dataSourceUrl": string
}}

No markdown fences. ONLY valid JSON.
"""


async def generate_dossier(town: str, business_type: str, analysis: dict) -> dict:
    """Generate a custom dossier for a specific business type."""
    logger.info("[dossier] Generating for '{}' in {}", business_type, town)
    wealth = analysis.get("wealthMetrics", {})
    demo = analysis.get("demographicData", {})

    # Get some web context
    web_result = search_web.invoke(
        {"query": f"{business_type} {town} Singapore feasibility cost revenue 2025 2026"}
    )

    llm = ChatGoogleGenerativeAI(
        model="gemini-3-flash-preview",
        google_api_key=settings.gemini_api_key,
    )

    prompt = DOSSIER_PROMPT.format(
        business_type=business_type,
        town=town,
        wealth_tier=wealth.get("wealthTier", "Mass Market"),
        median_income=wealth.get("medianHouseholdIncome", "N/A"),
        population=demo.get("residentPopulation", "N/A"),
    )

    if web_result.get("fetch_status") == "VERIFIED":
        prompt += f"\n\nWeb research context:\n{str(web_result.get('data', ''))[:2000]}"

    response = llm.invoke([
        SystemMessage(content="You are a business feasibility analyst for Singapore."),
        HumanMessage(content=prompt),
    ])

    try:
        raw_text = response.content
        if "```json" in raw_text:
            raw_text = raw_text.split("```json")[1].split("```")[0]
        elif "```" in raw_text:
            raw_text = raw_text.split("```")[1].split("```")[0]
        dossier = json.loads(raw_text.strip())
        logger.success("[dossier] Complete for '{}' in {} — score {}",
            business_type, town, dossier.get("opportunityScore", "?"))
        return dossier
    except (json.JSONDecodeError, IndexError):
        logger.warning("[dossier] JSON parse failed for '{}' in {}", business_type, town)
        return {
            "businessType": business_type,
            "category": "Other",
            "opportunityScore": 50,
            "thesis": f"Unable to generate detailed analysis for {business_type} in {town}",
            "gapReason": "Analysis generation failed",
            "estimatedRental": 0,
            "suggestedLocations": [town],
            "businessProfile": {
                "size": "TBD", "targetAudience": "TBD",
                "strategy": "TBD", "employees": "TBD",
            },
            "financials": {
                "upfrontCost": 0, "monthlyCost": 0,
                "monthlyRevenueBad": 0, "monthlyRevenueAvg": 0, "monthlyRevenueGood": 0,
            },
            "dataSourceUrl": "",
        }
