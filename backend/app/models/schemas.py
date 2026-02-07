from __future__ import annotations

from pydantic import BaseModel
from typing import Any, Optional
from enum import Enum


class FetchStatus(str, Enum):
    VERIFIED = "VERIFIED"
    STALE = "STALE"
    AI_ESTIMATED = "AI_ESTIMATED"
    UNAVAILABLE = "UNAVAILABLE"


class DataPointEnvelope(BaseModel):
    """Every factual claim carries provenance."""
    value: Any
    source_id: str
    fetch_status: FetchStatus
    fetched_at: Optional[str] = None
    stale_days: Optional[int] = None
    raw_url: Optional[str] = None
    error: Optional[str] = None


# --- Core domain models (mirror types.ts) ---


class Financials(BaseModel):
    upfrontCost: float
    monthlyCost: float
    monthlyRevenueBad: float
    monthlyRevenueAvg: float
    monthlyRevenueGood: float


class BusinessProfile(BaseModel):
    size: str
    targetAudience: str
    strategy: str
    employees: str


class Recommendation(BaseModel):
    businessType: str
    category: str
    opportunityScore: float
    thesis: str
    gapReason: Optional[str] = None
    estimatedRental: Optional[float] = None
    suggestedLocations: list[str] = []
    businessProfile: BusinessProfile
    financials: Financials
    dataSourceTitle: Optional[str] = None
    dataSourceUrl: Optional[str] = None


class WealthMetrics(BaseModel):
    medianHouseholdIncome: str
    medianHouseholdIncomePerCapita: str
    privatePropertyRatio: str
    wealthTier: str
    sourceNote: Optional[str] = None
    dataSourceUrl: Optional[str] = None
    fetchStatus: Optional[str] = None
    staleDays: Optional[int] = None


class DistributionPoint(BaseModel):
    label: str
    value: float


class DemographicData(BaseModel):
    residentPopulation: str
    planningArea: Optional[str] = None
    ageDistribution: list[DistributionPoint]
    raceDistribution: list[DistributionPoint]
    employmentStatus: list[DistributionPoint]
    dataSourceUrl: Optional[str] = None
    fetchStatus: Optional[str] = None
    staleDays: Optional[int] = None


class DiscoveryLog(BaseModel):
    timestamp: str
    action: str
    result: str


class DiscoveryCategory(BaseModel):
    label: str
    logs: list[DiscoveryLog]


class PulseEvent(BaseModel):
    timestamp: str
    event: str
    impact: str  # positive, negative, neutral


class Tender(BaseModel):
    block: str
    street: str
    closingDate: str
    status: str
    areaSqft: float


class GroundingSource(BaseModel):
    title: str
    uri: str


class AreaAnalysis(BaseModel):
    town: str
    commercialPulse: str
    demographicsFocus: str
    wealthMetrics: WealthMetrics
    demographicData: DemographicData
    discoveryLogs: dict[str, DiscoveryCategory]
    pulseTimeline: list[PulseEvent]
    recommendations: list[Recommendation]
    activeTenders: list[Tender]
    sources: list[GroundingSource]
    monitoringStarted: str
    lastScannedAt: str


# --- Workflow event types (SSE) ---


class WorkflowEvent(BaseModel):
    timestamp: str
    event_type: str
    node: str
    detail: dict = {}


# --- Marathon-specific models ---


class ChangeEvent(BaseModel):
    date: str
    category: str
    change: str
    significance: str  # HIGH, MEDIUM, LOW, NOISE
    trend_direction: Optional[str] = None


class TownKnowledgeBase(BaseModel):
    town: str
    marathon_started: str
    total_runs: int
    last_run_at: str
    current_analysis: AreaAnalysis
    confidence: dict[str, float] = {}
    changelog: list[ChangeEvent] = []
    watch_items: list[dict] = []
    rental_history: list[dict] = []
    tender_history: list[dict] = []
    business_mix_history: list[dict] = []
    recommendation_history: list[dict] = []
