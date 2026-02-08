
export enum ScoutStatus {
  IDLE = 'IDLE',
  SCANNING = 'SCANNING',
  ANALYZING = 'ANALYZING',
  REPORTING = 'REPORTING',
  ERROR = 'ERROR'
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface DiscoveryLog {
  timestamp: string;
  action: string;
  result: string;
}

export interface DiscoveryCategory {
  label: string;
  logs: DiscoveryLog[];
}

export interface PulseEvent {
  timestamp: string;
  event: string;
  impact: 'positive' | 'negative' | 'neutral';
}

export interface BusinessProfile {
  size: string;
  targetAudience: string;
  strategy: string;
  employees: string;
}

export interface Financials {
  upfrontCost: number;
  monthlyCost: number;
  monthlyRevenueBad: number;
  monthlyRevenueAvg: number;
  monthlyRevenueGood: number;
}

export interface Recommendation {
  businessType: string;
  category: 'F&B' | 'Retail' | 'Wellness' | 'Education' | 'Services' | 'Other';
  opportunityScore: number;
  thesis: string;
  gapReason: string;
  estimatedRental: number;
  suggestedLocations: string[];
  businessProfile: BusinessProfile;
  financials: Financials;
  dataSourceTitle?: string;
  dataSourceUrl?: string;
}

export interface Tender {
  block: string;
  street: string;
  closingDate: string;
  status: string;
  areaSqft: number;
}

export interface WealthMetrics {
  medianHouseholdIncome: string;
  medianHouseholdIncomePerCapita: string;
  privatePropertyRatio: string;
  wealthTier: 'Mass Market' | 'Upper Mid' | 'Affluent' | 'Silver Economy';
  sourceNote: string;
  dataSourceUrl?: string;
}

export interface DataPoint {
  label: string;
  value: number;
}

export interface DemographicData {
  residentPopulation: string;
  planningArea: string;
  ageDistribution: DataPoint[];
  raceDistribution: DataPoint[];
  employmentStatus: DataPoint[];
  dataSourceUrl?: string;
}

export interface AreaAnalysis {
  town: string;
  commercialPulse: string;
  demographicsFocus: string;
  wealthMetrics: WealthMetrics;
  demographicData: DemographicData;
  discoveryLogs: {
    tenders: DiscoveryCategory;
    saturation: DiscoveryCategory;
    areaSaturation: DiscoveryCategory;
    traffic: DiscoveryCategory;
    rental: DiscoveryCategory;
  };
  pulseTimeline: PulseEvent[];
  recommendations: Recommendation[];
  activeTenders: Tender[];
  sources: GroundingSource[];
  monitoringStarted: string;
  lastScannedAt: string;
}

// --- Landing Page Types ---

export interface TownSummary {
  name: string;
  has_analysis: boolean;
  total_runs: number;
  last_run_at: string | null;
  wealth_tier?: string;
  population?: string;
  recommendation_count?: number;
  top_opportunity_score?: number;
  commercial_pulse?: string;
}

// --- Run History Types ---

export interface RunSummary {
  run_id: string;
  town: string;
  started_at: string;
  completed_at: string;
  status: 'completed' | 'failed';
  run_number: number;
  run_summary: string;
  directive: string;
  duration_ms: number;
  tool_call_count: number;
  delta_count: number;
  verified_count: number;
  failed_count: number;
}

export interface RunDetail {
  run_id: string;
  town: string;
  started_at: string;
  completed_at: string;
  status: 'completed' | 'failed';
  run_number: number;
  run_summary: string;
  directive: string;
  duration_ms: number;
  tool_calls: Array<{ source_id: string; fetch_status: string; error?: string; raw_url?: string }>;
  verification_report: Record<string, any>;
  fetch_failures: Array<{ source_id: string; error: string }>;
  deltas: Array<{ category: string; change: string; significance: string; trend_direction: string }>;
  analysis: Record<string, any>;
  error?: string;
}

// --- Workflow Visualizer Types (SSE from backend) ---

export interface WorkflowEvent {
  timestamp: string;
  event_type: 'run_started' | 'node_started' | 'tool_result' | 'node_completed'
    | 'delta_detected' | 'verification_flag' | 'run_completed' | 'run_failed';
  node: string;
  detail: Record<string, any>;
}

export interface ToolCallEntry {
  tool: string;
  url?: string;
  status: 'pending' | 'VERIFIED' | 'UNAVAILABLE' | 'STALE';
  error?: string;
}

export interface WorkflowNode {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
  toolCalls: ToolCallEntry[];
  summary?: string;
}

export interface WorkflowRun {
  town: string;
  status: 'running' | 'completed' | 'failed';
  nodes: WorkflowNode[];
  deltas: Array<{ category: string; change: string; significance: string }>;
  verificationFlags: Array<{ category: string; status: string; sources: string[] }>;
  runSummary?: string;
}
