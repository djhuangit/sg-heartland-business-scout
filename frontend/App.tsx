
import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { fetchAnalysis, fetchTowns, generateSpecificDossier, createScoutStream, fetchRunHistory, fetchRunDetail, clearTownCache } from './services/api';
import { ScoutStatus, AreaAnalysis, TownSummary, DiscoveryCategory, DataPoint, Recommendation, WorkflowEvent, WorkflowNode, WorkflowRun, AgentLogEntry, RunSummary, RunDetail } from './types';
import { HDB_TOWNS, Icons } from './constants';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, ReferenceLine, Legend } from 'recharts';
import { ReactFlow, Handle, Position, Background, Controls, useNodesState, useEdgesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';

const STORAGE_KEY_PREFIX = 'scout_sg_data_';

/**
 * Normalize analysis data from the backend to ensure all required fields exist.
 * The LLM may omit fields or return null instead of empty arrays, which causes
 * React rendering crashes (.map() on null).
 */
function normalizeAnalysis(data: any): AreaAnalysis {
  const emptyCategory = (label: string) => ({ label, logs: [] });
  const dl = data.discoveryLogs || {};
  const dm = data.demographicData || {};
  const wm = data.wealthMetrics || {};

  return {
    town: data.town || '',
    commercialPulse: data.commercialPulse || '',
    demographicsFocus: data.demographicsFocus || '',
    wealthMetrics: {
      medianHouseholdIncome: wm.medianHouseholdIncome || 'N/A',
      medianHouseholdIncomePerCapita: wm.medianHouseholdIncomePerCapita || 'N/A',
      privatePropertyRatio: wm.privatePropertyRatio || '0%',
      wealthTier: wm.wealthTier || 'Mass Market',
      sourceNote: wm.sourceNote || '',
      dataSourceUrl: wm.dataSourceUrl,
    },
    demographicData: {
      residentPopulation: dm.residentPopulation || 'N/A',
      planningArea: dm.planningArea || data.town || '',
      ageDistribution: Array.isArray(dm.ageDistribution) ? dm.ageDistribution : [],
      raceDistribution: Array.isArray(dm.raceDistribution) ? dm.raceDistribution : [],
      employmentStatus: Array.isArray(dm.employmentStatus) ? dm.employmentStatus : [],
      dataSourceUrl: dm.dataSourceUrl,
    },
    discoveryLogs: {
      tenders: dl.tenders || emptyCategory('HDB Tender Inventory'),
      saturation: dl.saturation || emptyCategory('Retail Mix Saturation'),
      areaSaturation: dl.areaSaturation || emptyCategory('Area Saturation Analysis'),
      traffic: dl.traffic || emptyCategory('Foot Traffic Proxies'),
      rental: dl.rental || emptyCategory('Rental Yield Potential'),
    },
    pulseTimeline: Array.isArray(data.pulseTimeline) ? data.pulseTimeline : [],
    recommendations: Array.isArray(data.recommendations)
      ? data.recommendations.map((r: any) => ({
          businessType: r.businessType || 'Unknown',
          category: r.category || 'Other',
          opportunityScore: r.opportunityScore ?? 0,
          thesis: r.thesis || '',
          gapReason: r.gapReason || '',
          estimatedRental: r.estimatedRental ?? 0,
          suggestedLocations: Array.isArray(r.suggestedLocations) ? r.suggestedLocations : [],
          businessProfile: {
            size: r.businessProfile?.size || 'N/A',
            targetAudience: r.businessProfile?.targetAudience || 'N/A',
            strategy: r.businessProfile?.strategy || 'N/A',
            employees: r.businessProfile?.employees || 'N/A',
          },
          financials: {
            upfrontCost: r.financials?.upfrontCost ?? 0,
            monthlyCost: r.financials?.monthlyCost ?? 0,
            monthlyRevenueBad: r.financials?.monthlyRevenueBad ?? 0,
            monthlyRevenueAvg: r.financials?.monthlyRevenueAvg ?? 0,
            monthlyRevenueGood: r.financials?.monthlyRevenueGood ?? 0,
          },
          dataSourceTitle: r.dataSourceTitle,
          dataSourceUrl: r.dataSourceUrl,
        }))
      : [],
    activeTenders: Array.isArray(data.activeTenders) ? data.activeTenders : [],
    sources: Array.isArray(data.sources) ? data.sources : [],
    monitoringStarted: data.monitoringStarted || new Date().toISOString(),
    lastScannedAt: data.lastScannedAt || new Date().toISOString(),
  };
}

// Mock data for the sidebar rental chart since realis data isn't fully structured in the LLM response yet
const RENTAL_TREND_DATA = [
  { name: 'Q1', v: 11.0 },
  { name: 'Q2', v: 11.5 },
  { name: 'Q3', v: 12.2 },
  { name: 'Q4', v: 12.8 },
  { name: 'Q1', v: 12.5 },
  { name: 'Q2', v: 13.4 }
];

// --- Hash routing ---
type AppView = { page: 'landing' } | { page: 'town'; town: string };

function parseHash(): AppView {
  const hash = window.location.hash;
  const townMatch = hash.match(/^#\/town\/(.+)$/);
  if (townMatch) {
    return { page: 'town', town: decodeURIComponent(townMatch[1]) };
  }
  return { page: 'landing' };
}

function navigateTo(view: AppView) {
  if (view.page === 'landing') {
    window.location.hash = '#/';
  } else {
    window.location.hash = `#/town/${encodeURIComponent(view.town)}`;
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const INITIAL_WORKFLOW_NODES: WorkflowNode[] = [
  { id: 'marathon_observer', label: 'Marathon Observer', status: 'pending', toolCalls: [], logs: [] },
  { id: 'demographics_agent', label: 'Demographics Agent', status: 'pending', toolCalls: [], logs: [] },
  { id: 'commercial_agent', label: 'Commercial Agent', status: 'pending', toolCalls: [], logs: [] },
  { id: 'market_intel_agent', label: 'Market Intel Agent', status: 'pending', toolCalls: [], logs: [] },
  { id: 'source_verifier', label: 'Source Verifier', status: 'pending', toolCalls: [], logs: [] },
  { id: 'delta_detector', label: 'Delta Detector', status: 'pending', toolCalls: [], logs: [] },
  { id: 'knowledge_integrator', label: 'Knowledge Integrator', status: 'pending', toolCalls: [], logs: [] },
  { id: 'strategist', label: 'Strategist', status: 'pending', toolCalls: [], logs: [] },
  { id: 'persist', label: 'Persist', status: 'pending', toolCalls: [], logs: [] },
];

// --- React Flow Pipeline Topology ---
const PIPELINE_NODE_DEFS = [
  { id: 'marathon_observer', label: 'Marathon Observer' },
  { id: 'demographics_agent', label: 'Demographics Agent' },
  { id: 'commercial_agent', label: 'Commercial Agent' },
  { id: 'market_intel_agent', label: 'Market Intel Agent' },
  { id: 'source_verifier', label: 'Source Verifier' },
  { id: 'delta_detector', label: 'Delta Detector' },
  { id: 'knowledge_integrator', label: 'Knowledge Integrator' },
  { id: 'strategist', label: 'Strategist' },
  { id: 'persist', label: 'Persist' },
];

const PIPELINE_EDGE_DEFS = [
  { id: 'e-obs-demo', source: 'marathon_observer', target: 'demographics_agent' },
  { id: 'e-obs-comm', source: 'marathon_observer', target: 'commercial_agent' },
  { id: 'e-obs-mkt', source: 'marathon_observer', target: 'market_intel_agent' },
  { id: 'e-demo-ver', source: 'demographics_agent', target: 'source_verifier' },
  { id: 'e-comm-ver', source: 'commercial_agent', target: 'source_verifier' },
  { id: 'e-mkt-ver', source: 'market_intel_agent', target: 'source_verifier' },
  { id: 'e-ver-delta', source: 'source_verifier', target: 'delta_detector' },
  { id: 'e-delta-ki', source: 'delta_detector', target: 'knowledge_integrator' },
  { id: 'e-ki-strat', source: 'knowledge_integrator', target: 'strategist' },
  { id: 'e-ki-persist', source: 'knowledge_integrator', target: 'persist' },
  { id: 'e-strat-persist', source: 'strategist', target: 'persist' },
];

const RF_NODE_W = 320;
const RF_NODE_H = 120;

function getLayoutedElements(workflowNodes: WorkflowNode[]) {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 });
  PIPELINE_NODE_DEFS.forEach(n => g.setNode(n.id, { width: RF_NODE_W, height: RF_NODE_H }));
  PIPELINE_EDGE_DEFS.forEach(e => g.setEdge(e.source, e.target));
  dagre.layout(g);

  const nodes = PIPELINE_NODE_DEFS.map(n => {
    const pos = g.node(n.id);
    const wn = workflowNodes.find(w => w.id === n.id);
    return {
      id: n.id,
      type: 'agent' as const,
      position: { x: pos.x - RF_NODE_W / 2, y: pos.y - RF_NODE_H / 2 },
      data: {
        label: n.label,
        status: wn?.status || 'pending',
        toolCalls: wn?.toolCalls || [],
        logs: wn?.logs || [],
        llmPreview: wn?.llmPreview,
      },
    };
  });

  const edges = PIPELINE_EDGE_DEFS.map(e => {
    const src = workflowNodes.find(w => w.id === e.source);
    const tgt = workflowNodes.find(w => w.id === e.target);
    const isActive = src?.status === 'completed' && tgt?.status === 'running';
    const isDone = src?.status === 'completed' && (tgt?.status === 'completed' || tgt?.status === 'skipped');
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      animated: isActive,
      style: {
        stroke: isDone ? '#22c55e' : isActive ? '#ef4444' : '#cbd5e1',
        strokeWidth: isActive ? 2 : 1,
      },
    };
  });

  return { nodes, edges };
}

const App: React.FC = () => {
  const [view, setView] = useState<AppView>(parseHash);
  const [landingKey, setLandingKey] = useState(0);
  const town = view.page === 'town' ? view.town : '';
  const [status, setStatus] = useState<ScoutStatus>(ScoutStatus.IDLE);
  const [analysis, setAnalysis] = useState<AreaAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<DiscoveryCategory | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showTimelineModal, setShowTimelineModal] = useState(false);

  // Workflow visualizer state
  const [workflowRun, setWorkflowRun] = useState<WorkflowRun | null>(() => {
    if (!town) return null;
    try {
      const saved = sessionStorage.getItem('scout_workflow_' + town);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const eventSourceRef = useRef<EventSource | null>(null);

  // Recommendations Filter State
  const [recFilterCategory, setRecFilterCategory] = useState("All");
  const [recFilterScore, setRecFilterScore] = useState("0");
  const [recSortBy, setRecSortBy] = useState("score_desc");

  // Custom Dossier State
  const [customPrompt, setCustomPrompt] = useState("");
  const [isGeneratingCustom, setIsGeneratingCustom] = useState(false);

  // Run History State
  const [runHistory, setRunHistory] = useState<RunSummary[]>([]);
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetail | null>(null);
  const [isLoadingRunDetail, setIsLoadingRunDetail] = useState(false);

  // Sync hash → view state
  useEffect(() => {
    const onHashChange = () => setView(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Reset state when navigating to landing
  useEffect(() => {
    if (view.page === 'landing') {
      setAnalysis(null);
      setStatus(ScoutStatus.IDLE);
      setWorkflowRun(null);
    }
  }, [view.page]);

  // Load analysis from backend on town change, fallback to localStorage
  useEffect(() => {
    if (!town) return;
    let cancelled = false;
    fetchAnalysis(town)
      .then((data) => {
        if (!cancelled) {
          setAnalysis(normalizeAnalysis(data));
          setStatus(ScoutStatus.REPORTING);
        }
      })
      .catch(() => {
        if (!cancelled) {
          const saved = localStorage.getItem(STORAGE_KEY_PREFIX + town);
          if (saved) {
            try {
              setAnalysis(normalizeAnalysis(JSON.parse(saved)));
              setStatus(ScoutStatus.REPORTING);
            } catch {
              setAnalysis(null);
              setStatus(ScoutStatus.IDLE);
            }
          } else {
            setAnalysis(null);
            setStatus(ScoutStatus.IDLE);
          }
        }
      });
    return () => { cancelled = true; };
  }, [town]);

  // Cache analysis in localStorage as offline backup
  useEffect(() => {
    if (analysis) {
      localStorage.setItem(STORAGE_KEY_PREFIX + analysis.town, JSON.stringify(analysis));
    }
  }, [analysis]);

  // Persist workflowRun to sessionStorage
  useEffect(() => {
    if (workflowRun && town) {
      sessionStorage.setItem('scout_workflow_' + town, JSON.stringify(workflowRun));
    }
  }, [workflowRun, town]);

  // Fetch run history when town changes or after a scan completes
  useEffect(() => {
    if (!town) return;
    fetchRunHistory(town).then(data => setRunHistory(data.runs)).catch(() => setRunHistory([]));
  }, [town, status]);

  const handleViewRunDetail = async (runId: string) => {
    setIsLoadingRunDetail(true);
    try {
      const detail = await fetchRunDetail(runId);
      setSelectedRunDetail(detail);
    } catch {
      alert('Failed to load run details');
    } finally {
      setIsLoadingRunDetail(false);
    }
  };

  const updateNodeStatus = useCallback((nodeId: string, newStatus: WorkflowNode['status'], summary?: string) => {
    setWorkflowRun(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        nodes: prev.nodes.map(n =>
          n.id === nodeId ? { ...n, status: newStatus, ...(summary ? { summary } : {}) } : n
        ),
      };
    });
  }, []);

  const addToolCall = useCallback((nodeId: string, tool: string, toolStatus: string, error?: string, url?: string) => {
    setWorkflowRun(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        nodes: prev.nodes.map(n =>
          n.id === nodeId
            ? { ...n, toolCalls: [...n.toolCalls, { tool, status: toolStatus as any, error, url }] }
            : n
        ),
      };
    });
  }, []);

  const handleScout = async () => {
    setStatus(ScoutStatus.SCANNING);
    setError(null);

    // Initialize workflow run
    const run: WorkflowRun = {
      town,
      status: 'running',
      nodes: INITIAL_WORKFLOW_NODES.map(n => ({ ...n, toolCalls: [], logs: [] })),
      deltas: [],
      verificationFlags: [],
    };
    setWorkflowRun(run);

    // Close any previous EventSource
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = createScoutStream(town);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const event: WorkflowEvent = JSON.parse(e.data);

        switch (event.event_type) {
          case 'node_started':
            updateNodeStatus(event.node, 'running');
            break;

          case 'tool_result':
            addToolCall(
              event.node,
              event.detail.tool || event.detail.source || 'unknown',
              event.detail.status || 'UNAVAILABLE',
              event.detail.error,
              event.detail.url,
            );
            break;

          case 'node_completed':
            updateNodeStatus(event.node, 'completed', event.detail?.reason);
            // If strategist was skipped (started with status: skipped)
            if (event.node === 'strategist' && event.detail?.status === 'skipped') {
              updateNodeStatus('strategist', 'skipped', event.detail.reason);
            }
            break;

          case 'verification_flag':
            setWorkflowRun(prev => prev ? {
              ...prev,
              verificationFlags: [...prev.verificationFlags, {
                category: event.detail.category,
                status: event.detail.status,
                sources: event.detail.sources || [],
              }],
            } : prev);
            break;

          case 'delta_detected':
            setWorkflowRun(prev => prev ? {
              ...prev,
              deltas: [...prev.deltas, {
                category: event.detail.category || 'unknown',
                change: event.detail.change || event.detail.what_changed || '',
                significance: event.detail.significance || 'LOW',
              }],
            } : prev);
            break;

          case 'run_completed':
            es.close();
            eventSourceRef.current = null;
            setWorkflowRun(prev => prev ? {
              ...prev,
              status: 'completed',
              runSummary: event.detail.run_summary,
            } : prev);
            // Fetch the completed analysis
            fetchAnalysis(town)
              .then(data => {
                setAnalysis(normalizeAnalysis(data));
                setStatus(ScoutStatus.REPORTING);
              })
              .catch(() => setStatus(ScoutStatus.REPORTING));
            break;

          case 'agent_log':
            setWorkflowRun(prev => {
              if (!prev) return prev;
              return {
                ...prev,
                nodes: prev.nodes.map(n =>
                  n.id === event.node
                    ? {
                        ...n,
                        logs: [...n.logs, {
                          type: event.detail.type,
                          message: event.detail.message,
                          tool: event.detail.tool,
                          status: event.detail.status,
                          error: event.detail.error,
                          preview: event.detail.preview,
                          url: event.detail.url,
                          timestamp: event.timestamp,
                        }],
                        ...(event.detail.type === 'llm_done' ? { llmPreview: event.detail.preview } : {}),
                      }
                    : n
                ),
              };
            });
            break;

          case 'run_failed':
            es.close();
            eventSourceRef.current = null;
            setWorkflowRun(prev => prev ? { ...prev, status: 'failed' } : prev);
            setError(event.detail.error || 'Pipeline failed');
            setStatus(ScoutStatus.ERROR);
            break;
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      // If we're still scanning, it means an unexpected disconnect
      setStatus(prev => prev === ScoutStatus.SCANNING ? ScoutStatus.ERROR : prev);
      setError(prev => prev || 'Connection to backend lost');
    };
  };

  const handleGenerateCustom = async () => {
    if (!analysis || !customPrompt.trim()) return;
    setIsGeneratingCustom(true);
    try {
      const newRec = await generateSpecificDossier(town, customPrompt);
      const normalizedRec = normalizeAnalysis({ recommendations: [newRec] }).recommendations[0];
      const updatedAnalysis = {
        ...analysis,
        recommendations: [normalizedRec, ...analysis.recommendations]
      };
      setAnalysis(updatedAnalysis);
      setCustomPrompt("");
      setRecFilterCategory("All");
    } catch (err) {
      console.error(err);
      alert("Failed to generate custom dossier. Please try again.");
    } finally {
      setIsGeneratingCustom(false);
    }
  };

  const isStale = analysis && new Date(analysis.lastScannedAt).toLocaleDateString() !== new Date().toLocaleDateString();

  const filteredRecommendations = useMemo(() => {
    if (!analysis) return [];
    
    let result = analysis.recommendations.filter(rec => {
      const matchesCategory = recFilterCategory === "All" || rec.category === recFilterCategory;
      const matchesScore = rec.opportunityScore >= parseInt(recFilterScore);
      return matchesCategory && matchesScore;
    });

    return result.sort((a, b) => {
      switch (recSortBy) {
        case 'cost_asc':
          return a.financials.upfrontCost - b.financials.upfrontCost;
        case 'cost_desc':
          return b.financials.upfrontCost - a.financials.upfrontCost;
        case 'rev_desc':
          return b.financials.monthlyRevenueAvg - a.financials.monthlyRevenueAvg;
        case 'score_asc':
          return a.opportunityScore - b.opportunityScore;
        case 'score_desc':
        default:
          return b.opportunityScore - a.opportunityScore;
      }
    });
  }, [analysis, recFilterCategory, recFilterScore, recSortBy]);

  const getTenderBadgeStyle = (status: string) => {
    const s = (status || 'NA').toUpperCase();
    if (s === 'OPEN' || s === 'LIVE') return 'bg-red-600 text-white';
    if (s === 'AWARDED') return 'bg-blue-600 text-white';
    if (s === 'CLOSED') return 'bg-slate-600 text-white';
    return 'bg-slate-200 text-slate-500';
  };

  const getDomain = (url: string) => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return 'Web Source';
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 overflow-x-hidden pb-12">
      <header className="sticky top-0 z-50 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigateTo({ page: 'landing' })}>
          <div className="bg-red-600 p-2 rounded-lg shadow-inner">
            <Icons.Map className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Heartland Scout <span className="text-red-600">SG</span></h1>
            <p className="text-xs text-slate-500 font-medium uppercase tracking-tighter">
              {view.page === 'town' ? `Monitoring ${town}` : 'Business Intelligence Engine'}
            </p>
          </div>
        </div>
        {view.page === 'town' && (
          <div className="flex gap-3">
            {analysis && (
              <button
                onClick={() => {
                  clearTownCache(town).catch(() => {});
                  localStorage.removeItem(STORAGE_KEY_PREFIX + town);
                  sessionStorage.removeItem('scout_workflow_' + town);
                  setAnalysis(null);
                  setStatus(ScoutStatus.IDLE);
                  setWorkflowRun(null);
                  setRunHistory([]);
                  setLandingKey(k => k + 1);
                }}
                className="px-4 py-2 rounded-md text-sm font-medium border border-slate-200 text-slate-500 hover:text-red-600 hover:border-red-200 transition-colors flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                Clear Cache
              </button>
            )}
            <button
              onClick={handleScout}
              disabled={status === ScoutStatus.SCANNING}
              className={`px-8 py-2 rounded-md text-sm font-bold transition-all disabled:opacity-50 flex items-center gap-2 shadow-sm ${
                isStale ? 'bg-orange-600 hover:bg-orange-700 animate-pulse' : 'bg-red-600 hover:bg-red-700'
              } text-white`}
            >
              {status === ScoutStatus.SCANNING ? 'Syncing...' : isStale ? 'Sync for Today' : 'Identify Gaps'}
              <Icons.Search className="w-4 h-4" />
            </button>
          </div>
        )}
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {view.page === 'landing' && <LandingPage key={landingKey} onSelectTown={(t) => navigateTo({ page: 'town', town: t })} />}

        {view.page === 'town' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* Breadcrumb */}
        <div className="lg:col-span-12">
          <button
            onClick={() => navigateTo({ page: 'landing' })}
            className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-red-600 transition-colors font-medium"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            All Towns
          </button>
        </div>

        {/* Sidebar Feed - Left Column */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          {/* Agent Activity Panel — compact linear view */}
          {workflowRun && (
            <AgentActivityPanel
              workflowRun={workflowRun}
              onOpenDetail={() => setSelectedNode('__pipeline__')}
            />
          )}

          {analysis && (
            <>
              {/* Open HDB Commercial Tenders - Sidebar Version */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                <h3 className="font-black text-slate-900 mb-4 flex items-center gap-2 uppercase tracking-[0.2em] text-[10px]">
                  <Icons.Alert className="w-3 h-3 text-red-600" />
                  Open HDB Tenders
                </h3>
                <div className="space-y-3 overflow-y-auto max-h-[240px] pr-1 custom-scrollbar">
                  {analysis.activeTenders && analysis.activeTenders.length > 0 ? (
                    analysis.activeTenders.map((t, idx) => (
                      <div key={idx} className="p-3 bg-slate-50 rounded-xl border border-slate-100 group hover:border-red-200 transition-all cursor-pointer relative overflow-hidden">
                        <div className="flex justify-between items-start mb-1">
                          <span className="font-bold text-[11px] text-slate-800">Blk {t.block} Unit</span>
                          <span className={`text-[7px] px-2 py-0.5 rounded-full font-black ${getTenderBadgeStyle(t.status)}`}>
                            {t.status || 'NA'}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 truncate mb-2">{t.street}</p>
                        <div className="flex justify-between items-center text-[9px] font-mono">
                           <span className="text-slate-400 font-bold">{t.areaSqft} SQFT</span>
                           <span className="text-red-600 font-black">By: {t.closingDate}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="py-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-200">
                      <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest px-4 italic leading-relaxed">No active tenders identified.</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Rental Growth Trajectory - Sidebar Version */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col">
                 <h3 className="font-black text-slate-900 mb-4 uppercase tracking-[0.2em] text-[10px]">Rental Growth (URA)</h3>
                 <div className="h-[140px] w-full -ml-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={RENTAL_TREND_DATA} margin={{ top: 5, right: 0, bottom: 5, left: 0 }}>
                        <defs>
                          <linearGradient id="colorV" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.2}/>
                            <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis 
                          dataKey="name" 
                          tick={{fontSize: 9, fill: '#94a3b8'}} 
                          axisLine={true} 
                          tickLine={true} 
                          interval={1}
                        />
                        <YAxis 
                          domain={['dataMin - 1', 'dataMax + 1']} 
                          tick={{fontSize: 9, fill: '#94a3b8'}} 
                          width={25} 
                          axisLine={true} 
                          tickLine={true} 
                        />
                        <Area type="monotone" dataKey="v" stroke="#ef4444" fillOpacity={1} fill="url(#colorV)" strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                 </div>
                 <p className="text-[8px] text-slate-400 text-center font-bold uppercase tracking-widest mt-1">Historical Realis Benchmarking (Index)</p>
              </div>
            </>
          )}

          {/* Run History */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-black text-slate-900 flex items-center gap-2 uppercase tracking-[0.2em] text-[10px]">
                <Icons.TrendUp className="w-3 h-3 text-red-600" />
                Run History
              </h3>
              {runHistory.length > 0 && (
                <span className="text-[9px] font-mono text-slate-400">{runHistory.length} runs</span>
              )}
            </div>
            <div className="space-y-2 overflow-y-auto max-h-[280px] pr-1 custom-scrollbar">
              {runHistory.length > 0 ? (
                runHistory.map((run) => (
                  <div
                    key={run.run_id}
                    onClick={() => handleViewRunDetail(run.run_id)}
                    className="p-3 bg-slate-50 rounded-xl border border-slate-100 cursor-pointer hover:border-red-200 hover:bg-red-50/20 transition-all group"
                  >
                    <div className="flex justify-between items-start mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${run.status === 'completed' ? 'bg-green-500' : 'bg-red-500'}`} />
                        <span className="text-[10px] font-bold text-slate-700 group-hover:text-red-600 transition-colors">
                          Run #{run.run_number}
                        </span>
                      </div>
                      <span className={`text-[7px] px-1.5 py-0.5 rounded-full font-black uppercase ${
                        run.directive === 'cold_start' ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {run.directive === 'cold_start' ? 'Cold Start' : 'Incremental'}
                      </span>
                    </div>
                    <p className="text-[9px] font-mono text-slate-400 mb-1.5">
                      {new Date(run.started_at).toLocaleString()}
                    </p>
                    <div className="flex items-center gap-3 text-[8px] font-bold text-slate-400 uppercase tracking-wider">
                      <span>{(run.duration_ms / 1000).toFixed(1)}s</span>
                      <span className="text-green-600">{run.verified_count} verified</span>
                      {run.failed_count > 0 && <span className="text-red-500">{run.failed_count} failed</span>}
                      <span>{run.delta_count} deltas</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-200">
                  <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest px-4 italic">No runs yet. Click "Identify Gaps" to start.</p>
                </div>
              )}
            </div>
          </div>

          {/* Pulse Timeline */}
          <div
            onClick={() => analysis && setShowTimelineModal(true)}
            className={`bg-slate-900 rounded-xl shadow-lg p-6 text-white overflow-hidden relative h-[400px] flex flex-col ${analysis ? 'cursor-pointer hover:ring-2 hover:ring-red-500/50 transition-all' : ''}`}
          >
             <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
               <Icons.TrendUp className="w-32 h-32" />
             </div>
             <div className="flex justify-between items-center mb-6 flex-shrink-0">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${status === ScoutStatus.SCANNING ? 'bg-orange-500 animate-pulse' : 'bg-red-500'}`} />
                  Pulse Timeline
                </h2>
             </div>
             <div className="flex-grow overflow-y-auto space-y-6 pr-2 custom-scrollbar-dark">
                {!analysis ? (
                  <div className="flex flex-col items-center justify-center py-16 text-slate-600 opacity-50">
                    <Icons.Alert className="w-8 h-8 mb-2" />
                    <p className="text-xs font-mono uppercase tracking-widest text-center px-4">Signals pending...</p>
                  </div>
                ) : (
                  analysis.pulseTimeline.map((h, i) => (
                    <div key={i} className="flex gap-4 relative pb-6 border-l border-slate-700 pl-4 ml-2 last:border-0 last:pb-0">
                      <div className={`absolute -left-[5px] top-1 w-2 h-2 rounded-full ring-4 ring-slate-900 ${h.impact === 'positive' ? 'bg-green-500' : h.impact === 'negative' ? 'bg-red-500' : 'bg-slate-400'}`} />
                      <div>
                        <p className="text-[10px] font-mono text-slate-500 mb-1">{h.timestamp}</p>
                        <p className="text-sm leading-relaxed text-slate-300 font-medium">{h.event}</p>
                      </div>
                    </div>
                  ))
                )}
             </div>
          </div>
        </div>

        {/* Intelligence Stream - Right Column */}
        <div className="lg:col-span-8 space-y-6">
          {status === ScoutStatus.IDLE && (
            <div className="h-full flex flex-col items-center justify-center bg-white rounded-xl border-2 border-dashed border-slate-200 p-20 text-center">
              <div className="bg-slate-50 p-6 rounded-full mb-6 shadow-inner">
                <Icons.Map className="w-12 h-12 text-slate-300" />
              </div>
              <h3 className="text-xl font-bold text-slate-800 tracking-tight">Heartland Scout Engine</h3>
              <p className="text-slate-500 max-w-sm mt-2 italic font-serif leading-relaxed">"Select a planning area to decode its DNA. We synthesize SingStat demographics with real-time commercial opportunities."</p>
            </div>
          )}

          {status === ScoutStatus.ERROR && error && (
            <div className="h-full flex flex-col items-center justify-center bg-white rounded-xl border-2 border-red-200 p-20 text-center">
              <div className="bg-red-50 p-4 rounded-full mb-4">
                <Icons.Alert className="w-8 h-8 text-red-500" />
              </div>
              <h3 className="text-lg font-bold text-slate-800">Pipeline Error</h3>
              <p className="text-sm text-red-600 mt-2 max-w-md">{error}</p>
              <button onClick={handleScout} className="mt-4 px-6 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700">
                Retry
              </button>
            </div>
          )}

          {analysis && (
            <>
              {/* 1. Town Overview */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8">
                <div className="flex justify-between items-start">
                  <div>
                    <h2 className="text-5xl font-black text-slate-900 uppercase tracking-tighter mb-2">{analysis.town}</h2>
                    <p className="text-slate-600 font-medium text-xl leading-relaxed italic max-w-2xl">"{analysis.commercialPulse}"</p>
                  </div>
                  {isStale && (
                    <span className="bg-orange-100 text-orange-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-orange-200 animate-pulse">Update Available</span>
                  )}
                </div>
              </div>

              {/* 2. Target Identity Widget */}
              <div className="bg-slate-50/50 rounded-xl border border-slate-200 p-3 px-5 flex items-center justify-between group">
                <div className="flex items-center gap-4">
                  <div className="p-1.5 bg-white rounded-lg border border-slate-100 shadow-sm transition-all group-hover:border-red-200">
                    <Icons.TrendUp className="w-4 h-4 text-slate-400 group-hover:text-red-500" />
                  </div>
                  <div>
                    <p className="text-[8px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-0.5">Primary Target Segment</p>
                    <h3 className="text-sm font-medium text-slate-700 tracking-tight">{analysis.demographicsFocus}</h3>
                  </div>
                </div>
                <div className="hidden sm:flex flex-col items-end border-l border-slate-200 pl-4 ml-4">
                  <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Planning Area</p>
                  <p className="text-xs font-semibold text-slate-500">{analysis.demographicData.planningArea || analysis.town}</p>
                </div>
              </div>

              {/* 3. Consolidated Demographics & Wealth Intelligence */}
              <div className="bg-slate-900 rounded-2xl shadow-xl overflow-hidden text-white border border-slate-800 transition-all hover:shadow-2xl">
                <div className="p-8 border-b border-slate-800 flex justify-between items-center bg-slate-950/30">
                  <h3 className="text-sm font-black uppercase tracking-[0.3em] text-red-500">Wealth & Population Intelligence</h3>
                  <div className="flex gap-2">
                    {isStale && (
                      <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 bg-amber-950/40 border border-amber-900/50 rounded text-[9px] font-black uppercase tracking-widest text-amber-500">
                        <Icons.Alert className="w-3 h-3" />
                        <span>Data: {new Date(analysis.lastScannedAt).toLocaleDateString()}</span>
                      </div>
                    )}
                    {analysis.wealthMetrics.dataSourceUrl ? (
                      <a href={analysis.wealthMetrics.dataSourceUrl} target="_blank" rel="noopener noreferrer" className="px-3 py-1 bg-slate-800 hover:bg-slate-700 transition-colors rounded text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                        SINGSTAT 2020/21
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                      </a>
                    ) : (
                      <span className="px-3 py-1 bg-slate-800 rounded text-[9px] font-black uppercase tracking-widest text-slate-400">SINGSTAT 2020/21</span>
                    )}
                    <span className="px-3 py-1 bg-red-600 rounded text-[9px] font-black uppercase tracking-widest text-white">{analysis.wealthMetrics.wealthTier}</span>
                  </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-800">
                  {/* Wealth Column */}
                  <div className="p-8 space-y-8 bg-slate-900/50">
                    <div>
                      <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4">Household Income Profile</p>
                      <div className="space-y-6">
                        <div className="p-4 bg-slate-800/40 rounded-xl border border-slate-800 group hover:border-red-900/50 transition-colors">
                          <p className="text-3xl font-black text-white group-hover:text-red-400 transition-colors">{analysis.wealthMetrics.medianHouseholdIncome}</p>
                          <p className="text-[10px] text-slate-500 font-mono mt-1 uppercase tracking-widest font-bold">Monthly HH Median</p>
                        </div>
                        <div className="p-4 bg-slate-800/40 rounded-xl border border-slate-800 group hover:border-red-900/50 transition-colors">
                          <p className="text-2xl font-black text-white group-hover:text-red-400 transition-colors">{analysis.wealthMetrics.medianHouseholdIncomePerCapita}</p>
                          <p className="text-[10px] text-slate-500 font-mono mt-1 uppercase tracking-widest font-bold">Income Per Capita</p>
                        </div>
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] font-black uppercase tracking-widest mb-3">
                        <span className="text-slate-500">Private Property Mix</span>
                        <span className="text-red-500">{analysis.wealthMetrics.privatePropertyRatio}</span>
                      </div>
                      <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden shadow-inner">
                        <div className="h-full bg-gradient-to-r from-red-800 to-red-500" style={{ width: analysis.wealthMetrics.privatePropertyRatio }} />
                      </div>
                      <p className="text-[9px] text-slate-600 font-mono mt-3 italic">Ref: {analysis.wealthMetrics.sourceNote || 'Census Benchmarks'}</p>
                    </div>
                  </div>

                  {/* Demographics Columns (Consolidated) */}
                  <div className="p-8 space-y-10 md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-10 bg-slate-950/10">
                    <div className="space-y-8">
                      <div>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 bg-blue-500 rounded-full" /> Age Distribution
                        </p>
                        <div className="space-y-4">
                          {analysis.demographicData.ageDistribution.map((d, i) => (
                            <DistributionBar key={i} label={d.label} value={d.value} color="bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.4)]" />
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 bg-green-500 rounded-full" /> Employment Status
                        </p>
                        <div className="space-y-4">
                          {analysis.demographicData.employmentStatus.map((d, i) => (
                            <DistributionBar key={i} label={d.label} value={d.value} color="bg-emerald-600 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-8">
                      <div>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 bg-red-500 rounded-full" /> Race Composition
                        </p>
                        <div className="space-y-4">
                          {analysis.demographicData.raceDistribution.map((d, i) => (
                            <DistributionBar key={i} label={d.label} value={d.value} color="bg-red-600 shadow-[0_0_8px_rgba(220,38,38,0.4)]" />
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-3">Residential Density</p>
                        <div className="bg-slate-800/30 p-5 rounded-2xl border border-slate-800/50 flex flex-col justify-center items-center text-center">
                          <p className="text-3xl font-black text-white mb-1">{analysis.demographicData.residentPopulation}</p>
                          <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest font-bold">Total Residents</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 4. Strategic Recommendations - Vertical Investment Dossiers */}
              <div className="space-y-8 pt-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-black uppercase tracking-[0.4em] text-slate-400">Strategic Investment Dossiers</h3>
                  <div className="h-px flex-grow mx-6 bg-slate-200" />
                </div>
                
                {/* Custom Generation Card */}
                <div className="bg-gradient-to-br from-red-600 to-red-800 rounded-2xl p-6 shadow-lg text-white relative overflow-hidden group">
                  <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:opacity-20 transition-opacity">
                    <Icons.Search className="w-32 h-32 text-white" />
                  </div>
                  <div className="relative z-10">
                    <h4 className="text-lg font-bold tracking-tight mb-2">Targeted Opportunity Scan</h4>
                    <p className="text-red-100 text-xs mb-4 max-w-lg">Don't see your niche? Command the engine to perform a specific feasibility study for any business type.</p>
                    <div className="flex gap-2 max-w-md">
                      <input 
                        type="text" 
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        placeholder="e.g. Cat Cafe, Pilates Studio, Hardware Store" 
                        className="flex-grow px-4 py-2 rounded-lg bg-white/10 border border-white/20 text-white placeholder-red-200/50 text-sm focus:outline-none focus:ring-2 focus:ring-white/50"
                        onKeyDown={(e) => e.key === 'Enter' && handleGenerateCustom()}
                      />
                      <button 
                        onClick={handleGenerateCustom}
                        disabled={isGeneratingCustom || !customPrompt.trim()}
                        className="px-4 py-2 bg-white text-red-700 rounded-lg text-sm font-bold hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isGeneratingCustom ? 'Analyzing...' : 'Generate'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Filters Toolbar */}
                <div className="flex flex-col sm:flex-row gap-4 p-4 bg-white rounded-xl border border-slate-200 shadow-sm">
                  <div className="flex-1 relative flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-2">Filter By:</span>
                    <select 
                      className="flex-grow px-4 py-2 bg-slate-50 border border-slate-100 rounded-lg text-sm font-bold text-slate-600 focus:ring-2 focus:ring-red-500 focus:outline-none"
                      value={recFilterCategory}
                      onChange={(e) => setRecFilterCategory(e.target.value)}
                    >
                      <option value="All">All Categories</option>
                      <option value="F&B">F&B</option>
                      <option value="Retail">Retail</option>
                      <option value="Wellness">Wellness</option>
                      <option value="Education">Education</option>
                      <option value="Services">Services</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div className="flex gap-4">
                    <select 
                      className="px-4 py-2 bg-slate-50 border border-slate-100 rounded-lg text-sm font-bold text-slate-600 focus:ring-2 focus:ring-red-500 focus:outline-none"
                      value={recFilterScore}
                      onChange={(e) => setRecFilterScore(e.target.value)}
                    >
                      <option value="0">All Scores</option>
                      <option value="80">Score 80+</option>
                      <option value="90">Score 90+</option>
                    </select>
                    <select 
                      className="px-4 py-2 bg-slate-50 border border-slate-100 rounded-lg text-sm font-bold text-slate-600 focus:ring-2 focus:ring-red-500 focus:outline-none"
                      value={recSortBy}
                      onChange={(e) => setRecSortBy(e.target.value)}
                    >
                      <option value="score_desc">Highest Score</option>
                      <option value="score_asc">Lowest Score</option>
                      <option value="cost_asc">Lowest Startup Cost</option>
                      <option value="rev_desc">Highest Revenue</option>
                    </select>
                  </div>
                </div>

                {filteredRecommendations.length > 0 ? (
                  filteredRecommendations.map((rec, i) => (
                    <RecommendationCard key={i} rec={rec} isPrime={i === 0 && recSortBy === 'score_desc' && recFilterCategory === 'All'} />
                  ))
                ) : (
                  <div className="py-12 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                    <p className="text-sm font-medium text-slate-500 italic">No recommendations match your filters.</p>
                  </div>
                )}
              </div>

              {/* Verification Sources */}
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                  <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400">Source Grounding Verification</h3>
                  <div className="px-3 py-1 rounded-full bg-slate-100 text-slate-500 text-[9px] font-bold uppercase tracking-widest flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                    Verified Public Registries
                  </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                  
                  {/* Column 1: Population & Wealth */}
                  <div className="space-y-4">
                    <h4 className="text-[9px] font-black uppercase tracking-widest text-slate-900 border-b border-slate-100 pb-2 mb-2 flex items-center gap-2">
                      Population & Wealth
                    </h4>
                    <div className="space-y-2">
                      {[analysis.wealthMetrics.dataSourceUrl, analysis.demographicData.dataSourceUrl]
                        .filter((url, index, self) => url && self.indexOf(url) === index) // Unique
                        .map((url, i) => (
                        <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block group">
                          <div className="p-3 rounded-lg bg-slate-50 border border-slate-100 group-hover:border-red-200 group-hover:bg-red-50/30 transition-all">
                            <p className="text-[10px] font-bold text-slate-700 truncate mb-1">SingStat / URA Registry</p>
                            <p className="text-[9px] text-slate-400 font-mono truncate">{getDomain(url || '')}</p>
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>

                  {/* Column 2: Opportunity Benchmarks */}
                  <div className="space-y-4">
                    <h4 className="text-[9px] font-black uppercase tracking-widest text-slate-900 border-b border-slate-100 pb-2 mb-2">
                      Opportunity Benchmarks
                    </h4>
                    <div className="space-y-2">
                      {analysis.recommendations.map((rec, i) => rec.dataSourceUrl && (
                        <a key={i} href={rec.dataSourceUrl} target="_blank" rel="noopener noreferrer" className="block group">
                          <div className="p-3 rounded-lg bg-slate-50 border border-slate-100 group-hover:border-red-200 group-hover:bg-red-50/30 transition-all flex justify-between items-center gap-2">
                            <div className="truncate">
                              <p className="text-[10px] font-bold text-slate-700 truncate mb-1">{rec.businessType}</p>
                              <p className="text-[9px] text-slate-400 font-mono truncate">{getDomain(rec.dataSourceUrl)}</p>
                            </div>
                            <Icons.Search className="w-3 h-3 text-slate-300 group-hover:text-red-400 flex-shrink-0" />
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>

                  {/* Column 3: General Context */}
                  <div className="space-y-4">
                    <h4 className="text-[9px] font-black uppercase tracking-widest text-slate-900 border-b border-slate-100 pb-2 mb-2">
                      Deep Web Grounding
                    </h4>
                    <div className="space-y-2">
                      {analysis.sources.slice(0, 5).map((s, idx) => (
                        <a key={idx} href={s.uri} target="_blank" rel="noopener noreferrer" className="block group">
                          <div className="p-3 rounded-lg bg-slate-50 border border-slate-100 group-hover:border-red-200 group-hover:bg-red-50/30 transition-all">
                            <p className="text-[10px] font-bold text-slate-700 truncate mb-1">{s.title}</p>
                            <p className="text-[9px] text-slate-400 font-mono truncate">{getDomain(s.uri)}</p>
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>

                </div>
              </div>
            </>
          )}
        </div>
        {/* Close town view wrapper */}
        </div>
        )}
      </main>

      {/* Pipeline Detail Modal */}
      {selectedNode && workflowRun && (
        <PipelineDetailModal
          workflowRun={workflowRun}
          onClose={() => setSelectedNode(null)}
        />
      )}

      {selectedLog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
            <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-white sticky top-0 z-10">
              <div>
                <h2 className="text-2xl font-black text-slate-900 tracking-tighter uppercase">{selectedLog.label}</h2>
                <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mt-2 flex items-center gap-2">
                  <span className="w-2 h-2 bg-red-600 rounded-full animate-pulse" /> Audit Trail Indices
                </p>
              </div>
              <button onClick={() => setSelectedLog(null)} className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-8 overflow-y-auto space-y-6 bg-slate-50 flex-grow custom-scrollbar">
              {selectedLog.logs.map((log, i) => (
                <div key={i} className="p-6 bg-white rounded-3xl border border-slate-100 shadow-sm transition-all hover:border-red-200">
                  <div className="flex justify-between items-center border-b border-slate-50 pb-3 mb-4">
                    <span className="text-[10px] font-mono text-red-600 font-black tracking-widest">{log.timestamp}</span>
                  </div>
                  <p className="text-sm font-black text-slate-800 mb-3">{log.action}</p>
                  <div className="p-4 bg-slate-900 rounded-2xl shadow-inner">
                    <p className="text-[11px] font-mono text-green-400 leading-loose italic">{log.result}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showTimelineModal && analysis && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/80 backdrop-blur-md">
          <div className="bg-slate-900 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] border border-slate-700">
            <div className="p-8 border-b border-slate-800 flex justify-between items-center sticky top-0 z-10 bg-slate-900">
              <div>
                <h2 className="text-2xl font-black text-white uppercase tracking-tighter">Grounding Journal: {analysis.town}</h2>
                <p className="text-[10px] text-red-500 font-black uppercase tracking-[0.4em] mt-3 flex items-center gap-2">
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  PERSISTENT MONITORING ACTIVE
                </p>
              </div>
              <button onClick={() => setShowTimelineModal(false)} className="p-2 text-slate-400 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            
            <div className="p-10 overflow-y-auto flex-grow bg-slate-950 custom-scrollbar-dark">
              <div className="space-y-10">
                {analysis.pulseTimeline.map((h, i) => (
                  <div key={i} className="flex gap-8 relative pb-10 border-l-2 border-slate-800 pl-8 ml-4 last:border-0 last:pb-0">
                    <div className={`absolute -left-[9px] top-1.5 w-4 h-4 rounded-full ring-8 ring-slate-950 ${h.impact === 'positive' ? 'bg-green-500' : h.impact === 'negative' ? 'bg-red-500' : 'bg-slate-400'}`} />
                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] font-mono text-red-600 font-black tracking-widest uppercase">{h.timestamp}</span>
                      <p className="text-xl text-slate-100 font-black leading-tight tracking-tight">{h.event}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Run Detail Modal */}
      {selectedRunDetail && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white w-full max-w-3xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-white sticky top-0 z-10">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h2 className="text-xl font-black text-slate-900 tracking-tighter uppercase">
                    Run #{selectedRunDetail.run_number}
                  </h2>
                  <span className={`text-[8px] px-2 py-0.5 rounded-full font-black uppercase ${
                    selectedRunDetail.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                  }`}>
                    {selectedRunDetail.status}
                  </span>
                </div>
                <p className="text-[10px] text-slate-500 font-mono">
                  {selectedRunDetail.town} &middot; {new Date(selectedRunDetail.started_at).toLocaleString()} &middot; {(selectedRunDetail.duration_ms / 1000).toFixed(1)}s
                </p>
              </div>
              <button onClick={() => setSelectedRunDetail(null)} className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-grow space-y-6 custom-scrollbar">
              {/* Run Summary */}
              {selectedRunDetail.run_summary && (
                <div className="p-4 bg-green-50 border border-green-100 rounded-xl">
                  <p className="text-[9px] font-black uppercase tracking-widest text-green-600 mb-1">Summary</p>
                  <p className="text-sm text-green-800">{selectedRunDetail.run_summary}</p>
                </div>
              )}

              {/* Error (if failed) */}
              {selectedRunDetail.error && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl">
                  <p className="text-[9px] font-black uppercase tracking-widest text-red-600 mb-1">Error</p>
                  <p className="text-sm text-red-800 font-mono">{selectedRunDetail.error}</p>
                </div>
              )}

              {/* Tool Calls */}
              <div>
                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">
                  Tool Calls ({selectedRunDetail.tool_calls.length})
                </h4>
                <div className="space-y-1.5">
                  {selectedRunDetail.tool_calls.map((tc, i) => (
                    <div key={i} className="flex items-center gap-3 p-2.5 bg-slate-50 rounded-lg border border-slate-100">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        tc.fetch_status === 'VERIFIED' ? 'bg-green-500' : 'bg-red-500'
                      }`} />
                      <span className="text-[10px] font-bold text-slate-700 flex-grow">{tc.source_id}</span>
                      <span className={`text-[8px] px-2 py-0.5 rounded font-black uppercase ${
                        tc.fetch_status === 'VERIFIED' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {tc.fetch_status}
                      </span>
                      {tc.error && <span className="text-[9px] text-red-500 font-mono truncate max-w-[150px]">{tc.error}</span>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Deltas */}
              {selectedRunDetail.deltas.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">
                    Deltas ({selectedRunDetail.deltas.length})
                  </h4>
                  <div className="space-y-1.5">
                    {selectedRunDetail.deltas.map((d, i) => (
                      <div key={i} className="flex items-center gap-3 p-2.5 bg-slate-50 rounded-lg border border-slate-100">
                        <span className={`text-[8px] px-2 py-0.5 rounded font-black uppercase flex-shrink-0 ${
                          d.significance === 'HIGH' ? 'bg-red-100 text-red-700' :
                          d.significance === 'MEDIUM' ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-500'
                        }`}>
                          {d.significance}
                        </span>
                        <span className="text-[10px] font-bold text-slate-600">{d.category}</span>
                        <span className="text-[10px] text-slate-500 truncate">{d.change}</span>
                        <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase ml-auto flex-shrink-0 ${
                          d.trend_direction === 'NEW' ? 'bg-blue-100 text-blue-600' :
                          d.trend_direction === 'IMPROVING' ? 'bg-green-100 text-green-600' :
                          d.trend_direction === 'DECLINING' ? 'bg-red-100 text-red-600' :
                          'bg-slate-100 text-slate-400'
                        }`}>
                          {d.trend_direction}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Verification Report */}
              {selectedRunDetail.verification_report?.categories && (
                <div>
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">
                    Verification Report
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 bg-green-50 border border-green-100 rounded-lg text-center">
                      <p className="text-2xl font-black text-green-700">{selectedRunDetail.verification_report.verified_count || 0}</p>
                      <p className="text-[8px] font-bold uppercase tracking-widest text-green-600">Verified</p>
                    </div>
                    <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-center">
                      <p className="text-2xl font-black text-red-700">{selectedRunDetail.verification_report.failed_count || 0}</p>
                      <p className="text-[8px] font-bold uppercase tracking-widest text-red-600">Failed</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Run ID */}
              <div className="pt-2 border-t border-slate-100">
                <p className="text-[9px] font-mono text-slate-400">
                  Run ID: {selectedRunDetail.run_id}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="mt-12 py-16 text-center border-t border-slate-200 bg-white">
        <p className="text-[10px] text-slate-400 font-black uppercase tracking-[0.5em]">Heartland Scout SG • Intelligence Engine v6.0 • SingStat Powered</p>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        .custom-scrollbar-dark::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar-dark::-webkit-scrollbar-track { background: #020617; }
        .custom-scrollbar-dark::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
      `}</style>
    </div>
  );
};

const LandingPage: React.FC<{ onSelectTown: (town: string) => void }> = ({ onSelectTown }) => {
  const [towns, setTowns] = useState<TownSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTowns()
      .then(serverTowns => {
        // Enrich with localStorage cache for towns the server doesn't know about
        // (e.g. after server restart, localStorage still has previous analysis)
        const enriched = serverTowns.map(t => {
          if (t.has_analysis) return t;
          const cached = localStorage.getItem(STORAGE_KEY_PREFIX + t.name);
          if (!cached) return t;
          try {
            const a = JSON.parse(cached);
            return {
              ...t,
              has_analysis: true,
              _cached: true,
              wealth_tier: a.wealthMetrics?.wealthTier,
              population: a.demographicData?.residentPopulation,
              recommendation_count: a.recommendations?.length ?? 0,
              top_opportunity_score: a.recommendations?.length
                ? Math.max(...a.recommendations.map((r: any) => r.opportunityScore ?? 0))
                : undefined,
              commercial_pulse: a.commercialPulse,
              last_run_at: a.lastScannedAt || t.last_run_at,
            } as TownSummary & { _cached?: boolean };
          } catch {
            return t;
          }
        });
        setTowns(enriched);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const scannedCount = towns.filter(t => t.has_analysis).length;

  const getStatusBadge = (t: TownSummary & { _cached?: boolean }) => {
    if (!t.has_analysis) return { label: 'Not scanned', cls: 'bg-slate-100 text-slate-500' };
    if ((t as any)._cached) return { label: 'Cached', cls: 'bg-blue-100 text-blue-700' };
    if (t.last_run_at) {
      const hoursAgo = (Date.now() - new Date(t.last_run_at).getTime()) / 3600000;
      if (hoursAgo > 24) return { label: 'Stale', cls: 'bg-amber-100 text-amber-700' };
    }
    return { label: 'Scanned', cls: 'bg-green-100 text-green-700' };
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-red-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="bg-slate-900 rounded-2xl p-8 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-10">
          <Icons.Map className="w-48 h-48" />
        </div>
        <div className="relative z-10">
          <h2 className="text-3xl font-black tracking-tight mb-2">27 HDB Heartland Towns</h2>
          <p className="text-slate-400 text-sm max-w-lg">
            Select any town to decode its commercial DNA. The engine gathers real-time data from Singapore government APIs and generates investment-grade business recommendations.
          </p>
          <div className="flex gap-6 mt-6">
            <div>
              <p className="text-2xl font-black text-red-500">{scannedCount}</p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Towns Scanned</p>
            </div>
            <div>
              <p className="text-2xl font-black text-slate-300">{27 - scannedCount}</p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Awaiting Analysis</p>
            </div>
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {towns.map(t => {
          const badge = getStatusBadge(t);
          return (
            <div
              key={t.name}
              onClick={() => onSelectTown(t.name)}
              className="bg-white rounded-xl border border-slate-200 p-5 cursor-pointer hover:border-red-200 hover:shadow-md transition-all group"
            >
              <div className="flex justify-between items-start mb-3">
                <h3 className="text-sm font-black text-slate-900 uppercase tracking-wide group-hover:text-red-600 transition-colors">
                  {t.name}
                </h3>
                <span className={`text-[8px] px-2 py-0.5 rounded-full font-black uppercase tracking-wider ${badge.cls}`}>
                  {badge.label}
                </span>
              </div>

              {t.has_analysis ? (
                <div className="space-y-3">
                  {t.commercial_pulse && (
                    <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-2">"{t.commercial_pulse}"</p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    {t.wealth_tier && (
                      <div className="bg-slate-50 rounded-lg px-2 py-1.5">
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider">Wealth</p>
                        <p className="text-[11px] font-bold text-slate-700">{t.wealth_tier}</p>
                      </div>
                    )}
                    {t.population && (
                      <div className="bg-slate-50 rounded-lg px-2 py-1.5">
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider">Population</p>
                        <p className="text-[11px] font-bold text-slate-700">{t.population}</p>
                      </div>
                    )}
                    {t.recommendation_count != null && (
                      <div className="bg-slate-50 rounded-lg px-2 py-1.5">
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider">Opportunities</p>
                        <p className="text-[11px] font-bold text-slate-700">{t.recommendation_count}</p>
                      </div>
                    )}
                    {t.top_opportunity_score != null && (
                      <div className="bg-slate-50 rounded-lg px-2 py-1.5">
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider">Top Score</p>
                        <p className={`text-[11px] font-bold ${t.top_opportunity_score >= 85 ? 'text-green-600' : 'text-slate-700'}`}>{t.top_opportunity_score}</p>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[9px] font-mono text-slate-400">
                      {t.total_runs} run{t.total_runs !== 1 ? 's' : ''}
                    </span>
                    <span className="text-[9px] font-mono text-slate-400">
                      {t.last_run_at ? timeAgo(t.last_run_at) : 'Never'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="py-4 text-center">
                  <p className="text-[10px] text-slate-400 italic">Click to analyze</p>
                  <Icons.Search className="w-5 h-5 text-slate-200 mx-auto mt-2 group-hover:text-red-300 transition-colors" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const AgentNode = memo(({ data }: { data: any }) => {
  const statusColors: Record<string, string> = {
    pending: 'border-slate-200 bg-slate-50',
    running: 'border-red-300 bg-red-50 shadow-md shadow-red-100',
    completed: 'border-green-300 bg-white hover:bg-slate-50 cursor-pointer',
    skipped: 'border-slate-200 bg-slate-50 opacity-50',
    failed: 'border-red-400 bg-red-50',
  };

  const statusIcons: Record<string, string | null> = {
    pending: '\u25CB',
    running: null,
    completed: '\u2713',
    skipped: '\u2014',
    failed: '\u2715',
  };

  return (
    <div className={`rounded-xl border-2 px-6 py-5 min-w-[300px] transition-all ${statusColors[data.status] || ''}`}>
      <Handle type="target" position={Position.Top} className="!bg-slate-300 !w-3 !h-3" />

      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        {data.status === 'running' ? (
          <div className="w-5 h-5 border-2 border-slate-300 border-t-red-500 rounded-full animate-spin" />
        ) : (
          <span className={`text-base font-bold ${
            data.status === 'completed' ? 'text-green-600' :
            data.status === 'failed' ? 'text-red-600' : 'text-slate-400'
          }`}>{statusIcons[data.status]}</span>
        )}
        <span className="text-base font-bold text-slate-700 truncate">{data.label}</span>
      </div>

      {/* Tool call badges */}
      {data.toolCalls.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {data.toolCalls.map((tc: any, i: number) => (
            <span key={i} className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
              tc.status === 'VERIFIED' ? 'bg-green-100 text-green-700' :
              tc.status === 'pending' ? 'bg-slate-100 text-slate-500' :
              'bg-red-100 text-red-600'
            }`}>{tc.tool?.replace(/_/g, ' ') || 'tool'}</span>
          ))}
        </div>
      )}

      {/* Live logs (last 3, only when running) */}
      {data.status === 'running' && data.logs.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-2.5">
          {data.logs.slice(-3).map((log: any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs font-mono text-slate-500 truncate">
              {(log.type === 'tool_start' || log.type === 'llm_start') && (
                <div className="w-2.5 h-2.5 border border-slate-300 border-t-red-500 rounded-full animate-spin flex-shrink-0" />
              )}
              {log.type === 'tool_result' && (
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${log.status === 'VERIFIED' ? 'bg-green-500' : 'bg-red-500'}`} />
              )}
              {log.type === 'llm_done' && (
                <span className="w-2.5 h-2.5 bg-blue-500 rounded-full flex-shrink-0" />
              )}
              <span className="truncate">{log.message}</span>
            </div>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!bg-slate-300 !w-3 !h-3" />
    </div>
  );
});

const nodeTypes = { agent: AgentNode };

const PipelineFlow: React.FC<{
  workflowRun: WorkflowRun;
  onNodeClick?: (nodeId: string) => void;
}> = ({ workflowRun, onNodeClick }) => {
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => getLayoutedElements(workflowRun.nodes),
    [workflowRun.nodes]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<any>(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>(layoutedEdges);

  // Keep data in sync when workflow status changes
  const prevNodesRef = useRef(layoutedNodes);
  useEffect(() => {
    if (prevNodesRef.current !== layoutedNodes) {
      prevNodesRef.current = layoutedNodes;
      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
    }
  }, [layoutedNodes, layoutedEdges, setNodes, setEdges]);

  return (
    <div style={{ width: '100%', height: '70vh' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onNodeClick?.(node.id)}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#f1f5f9" gap={16} />
        <Controls />
      </ReactFlow>
    </div>
  );
};

const RecommendationCard: React.FC<{ rec: Recommendation; isPrime: boolean }> = ({ rec, isPrime }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [chartData, setChartData] = useState<any[]>([]);

  useEffect(() => {
    // Generate 36 months of data
    const data = [];
    const upfront = rec.financials.upfrontCost;
    const monthlyCost = rec.financials.monthlyCost;
    
    // Scenarios
    const scenarios = [
      { key: 'Bear Case', revenue: rec.financials.monthlyRevenueBad },
      { key: 'Base Case', revenue: rec.financials.monthlyRevenueAvg },
      { key: 'Bull Case', revenue: rec.financials.monthlyRevenueGood }
    ];

    for (let m = 0; m <= 36; m++) {
      const point: any = { month: m };
      scenarios.forEach(s => {
        // Cumulative Cashflow = -Upfront + (Month * (Revenue - Cost))
        const netProfit = s.revenue - monthlyCost;
        point[s.key] = -upfront + (m * netProfit);
      });
      data.push(point);
    }
    setChartData(data);
  }, [rec]);

  const formatCurrency = (val: number) => 
    new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD', maximumFractionDigits: 0 }).format(val);

  return (
    <div className={`bg-white rounded-3xl shadow-sm border ${isPrime ? 'border-red-200 ring-4 ring-red-50/50' : 'border-slate-200'} transition-all duration-300 flex flex-col group relative overflow-hidden ${isExpanded ? 'p-8' : 'p-6 hover:shadow-md'}`}>
      {isPrime && (
        <div className="absolute top-0 right-0 bg-red-600 text-white text-[9px] font-black uppercase tracking-widest px-4 py-1.5 rounded-bl-xl shadow-md z-10">
          Prime Match
        </div>
      )}
      
      {/* Header - Always Visible - Click to toggle */}
      <div 
        className="flex justify-between items-start cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex gap-4 w-full">
          <div className={`p-3 h-12 w-12 flex items-center justify-center rounded-2xl border flex-shrink-0 ${isPrime ? 'bg-red-50 border-red-100 text-red-600' : 'bg-slate-50 border-slate-100 text-slate-400'}`}>
            <Icons.TrendUp className="w-6 h-6" />
          </div>
          <div className="flex-grow">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mb-1">
              <h3 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">{rec.businessType}</h3>
              <div className="flex gap-2">
                <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest ${rec.opportunityScore > 85 ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                  Score: {rec.opportunityScore}
                </span>
                <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest bg-slate-100 text-slate-600 border border-slate-200">
                  {rec.category}
                </span>
              </div>
            </div>
            <p className="text-sm text-slate-500 font-medium leading-relaxed max-w-2xl line-clamp-2 sm:line-clamp-none">{rec.thesis}</p>
            
            {/* Collapsed State Preview Metrics */}
            {!isExpanded && (
               <div className="flex items-center gap-6 mt-4 opacity-75">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Est. Setup</p>
                    <p className="text-xs font-bold text-slate-700">{formatCurrency(rec.financials.upfrontCost)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Target Rev</p>
                    <p className="text-xs font-bold text-slate-700">{formatCurrency(rec.financials.monthlyRevenueAvg)}/mo</p>
                  </div>
                  <div className="flex items-center gap-1 text-red-600 text-[10px] font-black uppercase tracking-widest ml-auto pr-4">
                    Expand Dossier
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  </div>
               </div>
            )}
          </div>
        </div>
      </div>

      {/* Expanded Content */}
      <div className={`grid grid-cols-1 lg:grid-cols-12 gap-8 overflow-hidden transition-all duration-500 ease-in-out ${isExpanded ? 'max-h-[2000px] opacity-100 mt-8' : 'max-h-0 opacity-0'}`}>
        {/* Left Col: Blueprint & Financials */}
        <div className="lg:col-span-7 space-y-8">
          {/* Business Blueprint Grid */}
          <div className="bg-slate-50 rounded-2xl border border-slate-100 p-6">
            <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Operational Blueprint</h4>
            <div className="grid grid-cols-2 gap-y-6 gap-x-4">
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">Target Audience</p>
                <p className="text-xs font-bold text-slate-800 leading-snug">{rec.businessProfile.targetAudience}</p>
              </div>
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">Strategic Approach</p>
                <p className="text-xs font-bold text-slate-800 leading-snug">{rec.businessProfile.strategy}</p>
              </div>
              <div className="flex gap-4">
                <div>
                   <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">Scale</p>
                   <p className="text-xs font-bold text-slate-800">{rec.businessProfile.size}</p>
                </div>
                <div>
                   <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">Staffing</p>
                   <p className="text-xs font-bold text-slate-800">{rec.businessProfile.employees}</p>
                </div>
              </div>
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">Gap Analysis</p>
                <p className="text-xs font-medium text-slate-600 leading-snug">{rec.gapReason}</p>
              </div>
            </div>
          </div>

          {/* Financial Breakdown */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-5 bg-slate-900 rounded-2xl border border-slate-800 shadow-lg text-white">
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Est. Upfront Investment</p>
              <p className="text-2xl font-black text-white">{formatCurrency(rec.financials.upfrontCost)}</p>
              <p className="text-[9px] text-slate-500 mt-2 font-mono">Renovation, Equipment, Licenses</p>
            </div>
            <div className="p-5 bg-white rounded-2xl border border-slate-200 shadow-sm">
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Monthly Operating Cost</p>
              <p className="text-2xl font-black text-slate-900">{formatCurrency(rec.financials.monthlyCost)}</p>
              <p className="text-[9px] text-slate-400 mt-2 font-mono">Rent ({formatCurrency(rec.estimatedRental)} psf), Wages, Utilities</p>
            </div>
          </div>
        </div>

        {/* Right Col: Break Even Analysis */}
        <div className="lg:col-span-5 flex flex-col bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Break-Even Horizon (36 Months)</h4>
            <div className="flex gap-2">
              <span className="w-2 h-2 rounded-full bg-red-400" />
              <span className="w-2 h-2 rounded-full bg-slate-400" />
              <span className="w-2 h-2 rounded-full bg-green-500" />
            </div>
          </div>
          <div className="flex-grow min-h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis 
                  dataKey="month" 
                  tick={{fontSize: 10, fill: '#94a3b8'}} 
                  axisLine={false} 
                  tickLine={false}
                  interval={5}
                />
                <YAxis 
                  tickFormatter={(val) => `S$${val/1000}k`} 
                  tick={{fontSize: 10, fill: '#94a3b8'}} 
                  axisLine={false} 
                  tickLine={false}
                  width={45}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', fontSize: '11px', color: '#fff' }}
                  itemStyle={{ color: '#fff' }}
                  formatter={(value: number) => formatCurrency(value)}
                  labelFormatter={(label) => `Month ${label}`}
                />
                <ReferenceLine y={0} stroke="#cbd5e1" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="Bear Case" stroke="#f87171" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Base Case" stroke="#94a3b8" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Bull Case" stroke="#22c55e" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
             <div className="p-2 bg-red-50 rounded-lg">
                <p className="text-[8px] font-bold text-red-400 uppercase">Bear</p>
                <p className="text-[10px] font-black text-red-700">{formatCurrency(rec.financials.monthlyRevenueBad)}/mo</p>
             </div>
             <div className="p-2 bg-slate-50 rounded-lg">
                <p className="text-[8px] font-bold text-slate-400 uppercase">Base</p>
                <p className="text-[10px] font-black text-slate-700">{formatCurrency(rec.financials.monthlyRevenueAvg)}/mo</p>
             </div>
             <div className="p-2 bg-green-50 rounded-lg">
                <p className="text-[8px] font-bold text-green-600 uppercase">Bull</p>
                <p className="text-[10px] font-black text-green-700">{formatCurrency(rec.financials.monthlyRevenueGood)}/mo</p>
             </div>
          </div>
        </div>

        {/* Footer Info: Sources & Locations */}
        <div className="col-span-1 lg:col-span-12 mt-2 pt-6 border-t border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4 overflow-x-auto pb-2 md:pb-0">
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">Suggested Expansion Clusters:</span>
                {rec.suggestedLocations.map((loc, j) => (
                    <span key={j} className="text-[10px] bg-slate-50 text-slate-600 px-3 py-1 rounded-full border border-slate-100 font-bold whitespace-nowrap">
                    {loc}
                    </span>
                ))}
            </div>
            <div className="flex items-center gap-6">
                {rec.dataSourceUrl && (
                    <a href={rec.dataSourceUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-[9px] font-bold text-slate-400 hover:text-red-500 uppercase tracking-widest transition-colors whitespace-nowrap">
                        Market Reference
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    </a>
                )}
                <button 
                    onClick={(e) => { e.stopPropagation(); setIsExpanded(false); }}
                    className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-red-500 self-start md:self-auto"
                >
                    Collapse View
                    <svg className="w-3 h-3 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};

const DistributionBar: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div className="space-y-1.5">
    <div className="flex justify-between text-[10px] font-black uppercase tracking-widest">
      <span className="text-slate-400 truncate pr-4">{label}</span>
      <span className="text-white tabular-nums">{value}%</span>
    </div>
    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden shadow-inner">
      <div className={`h-full ${color} transition-all duration-1000 ease-out`} style={{ width: `${value}%` }} />
    </div>
  </div>
);

// --- Agent Activity Panel (compact sidebar widget) ---
const AgentActivityPanel: React.FC<{
  workflowRun: WorkflowRun;
  onOpenDetail: () => void;
}> = ({ workflowRun, onOpenDetail }) => {
  const completedCount = workflowRun.nodes.filter(n => n.status === 'completed' || n.status === 'skipped').length;
  const runningNode = workflowRun.nodes.find(n => n.status === 'running');

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      {/* Header */}
      <div
        className="px-4 py-3 border-b border-slate-100 flex items-center justify-between cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={onOpenDetail}
      >
        <div className="flex items-center gap-2.5">
          {workflowRun.status === 'running' ? (
            <div className="w-3.5 h-3.5 border-2 border-slate-200 border-t-red-500 rounded-full animate-spin" />
          ) : workflowRun.status === 'completed' ? (
            <span className="text-green-600 text-sm font-bold">{'\u2713'}</span>
          ) : (
            <span className="text-red-600 text-sm font-bold">{'\u2715'}</span>
          )}
          <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-wider">Agent Pipeline</h3>
          <span className="text-[9px] font-mono text-slate-400">{completedCount}/{workflowRun.nodes.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[8px] px-2 py-0.5 rounded-full font-bold uppercase ${
            workflowRun.status === 'running' ? 'bg-red-100 text-red-700 animate-pulse' :
            workflowRun.status === 'completed' ? 'bg-green-100 text-green-700' :
            'bg-red-100 text-red-600'
          }`}>{workflowRun.status}</span>
          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
        </div>
      </div>

      {/* Agent rows */}
      <div className="divide-y divide-slate-50 max-h-[360px] overflow-y-auto custom-scrollbar">
        {workflowRun.nodes.map(node => {
          const lastLog = node.logs.length > 0 ? node.logs[node.logs.length - 1] : null;
          return (
            <div key={node.id} className="px-4 py-2.5 flex items-start gap-2.5 hover:bg-slate-50/50 transition-colors">
              {/* Status */}
              <div className="mt-0.5 flex-shrink-0">
                {node.status === 'running' ? (
                  <div className="w-3 h-3 border-2 border-slate-200 border-t-red-500 rounded-full animate-spin" />
                ) : node.status === 'completed' ? (
                  <span className="w-3 h-3 rounded-full bg-green-500 block" />
                ) : node.status === 'failed' ? (
                  <span className="w-3 h-3 rounded-full bg-red-500 block" />
                ) : node.status === 'skipped' ? (
                  <span className="w-3 h-3 rounded-full bg-slate-300 block" />
                ) : (
                  <span className="w-3 h-3 rounded-full border-2 border-slate-200 block" />
                )}
              </div>

              {/* Content */}
              <div className="flex-grow min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] font-bold truncate ${
                    node.status === 'running' ? 'text-red-700' :
                    node.status === 'completed' ? 'text-slate-700' : 'text-slate-400'
                  }`}>{node.label}</span>
                  {node.toolCalls.length > 0 && (
                    <span className="text-[8px] font-mono text-slate-400 flex-shrink-0">{node.toolCalls.length} calls</span>
                  )}
                </div>
                {/* Live log line */}
                {lastLog && (
                  <p className="text-[10px] text-slate-400 truncate mt-0.5 font-mono">{lastLog.message}</p>
                )}
                {/* LLM preview for completed */}
                {node.status === 'completed' && node.llmPreview && !lastLog && (
                  <p className="text-[10px] text-slate-400 truncate mt-0.5 italic">{node.llmPreview}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Run summary footer */}
      {workflowRun.status === 'completed' && workflowRun.runSummary && (
        <div className="px-4 py-2.5 bg-green-50 border-t border-green-100">
          <p className="text-[10px] text-green-700 line-clamp-2">{workflowRun.runSummary}</p>
        </div>
      )}

      {/* Currently running hint */}
      {runningNode && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-100 flex items-center gap-2">
          <div className="w-2 h-2 border border-red-300 border-t-red-600 rounded-full animate-spin" />
          <p className="text-[10px] text-red-600 font-bold truncate">{runningNode.label}</p>
        </div>
      )}
    </div>
  );
};

// --- Pipeline Detail Modal (full history + optional React Flow) ---
const PipelineDetailModal: React.FC<{
  workflowRun: WorkflowRun;
  onClose: () => void;
}> = ({ workflowRun, onClose }) => {
  const [activeTab, setActiveTab] = useState<'log' | 'graph'>('log');
  const [graphSelectedNode, setGraphSelectedNode] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    // Auto-expand running nodes
    const running = new Set<string>();
    workflowRun.nodes.forEach(n => { if (n.status === 'running') running.add(n.id); });
    return running;
  });

  const toggleNode = (nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const expandAll = () => setExpandedNodes(new Set(workflowRun.nodes.map(n => n.id)));
  const collapseAll = () => setExpandedNodes(new Set());

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm">
      <div className="bg-white w-full max-w-7xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-white sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-lg font-black text-slate-900 tracking-tight uppercase">Agent Pipeline</h2>
              <p className="text-[10px] text-slate-500 font-mono">{workflowRun.town}</p>
            </div>
            <span className={`text-[9px] px-2.5 py-1 rounded-full font-bold uppercase ${
              workflowRun.status === 'running' ? 'bg-red-100 text-red-700 animate-pulse' :
              workflowRun.status === 'completed' ? 'bg-green-100 text-green-700' :
              'bg-red-100 text-red-600'
            }`}>{workflowRun.status}</span>
          </div>
          <div className="flex items-center gap-3">
            {/* Tab toggle */}
            <div className="flex bg-slate-100 rounded-lg p-0.5">
              <button
                onClick={() => setActiveTab('log')}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-colors ${
                  activeTab === 'log' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >Activity Log</button>
              <button
                onClick={() => setActiveTab('graph')}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-colors ${
                  activeTab === 'graph' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >Pipeline Graph</button>
            </div>
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-full transition-colors text-slate-400">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* Tab content */}
        {activeTab === 'log' ? (
          <div className="flex-grow overflow-y-auto custom-scrollbar">
            {/* Expand/Collapse controls */}
            <div className="px-6 py-2 border-b border-slate-50 flex items-center gap-3 bg-slate-50/50">
              <button onClick={expandAll} className="text-[9px] font-bold uppercase tracking-wider text-slate-400 hover:text-red-600 transition-colors">Expand All</button>
              <span className="text-slate-200">|</span>
              <button onClick={collapseAll} className="text-[9px] font-bold uppercase tracking-wider text-slate-400 hover:text-red-600 transition-colors">Collapse All</button>
            </div>

            <div className="divide-y divide-slate-100">
              {workflowRun.nodes.map(node => {
                const isExpanded = expandedNodes.has(node.id);
                const statusColor = node.status === 'completed' ? 'bg-green-500' :
                  node.status === 'running' ? 'bg-red-500 animate-pulse' :
                  node.status === 'failed' ? 'bg-red-500' :
                  node.status === 'skipped' ? 'bg-slate-300' : 'bg-slate-200';

                return (
                  <div key={node.id}>
                    {/* Agent header row */}
                    <div
                      className="px-6 py-3 flex items-center gap-3 cursor-pointer hover:bg-slate-50 transition-colors"
                      onClick={() => toggleNode(node.id)}
                    >
                      <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusColor}`} />
                      <span className="text-sm font-bold text-slate-800">{node.label}</span>
                      <div className="flex items-center gap-2 ml-auto">
                        {node.toolCalls.length > 0 && (
                          <span className="text-[9px] font-mono text-slate-400">{node.toolCalls.length} tool calls</span>
                        )}
                        {node.logs.length > 0 && (
                          <span className="text-[9px] font-mono text-slate-400">{node.logs.length} events</span>
                        )}
                        <span className={`text-[8px] px-2 py-0.5 rounded-full font-bold uppercase ${
                          node.status === 'completed' ? 'bg-green-100 text-green-700' :
                          node.status === 'running' ? 'bg-red-100 text-red-700' :
                          node.status === 'failed' ? 'bg-red-100 text-red-600' :
                          'bg-slate-100 text-slate-500'
                        }`}>{node.status}</span>
                      </div>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="px-6 pb-4 bg-slate-50/30">
                        {/* Tool calls */}
                        {node.toolCalls.length > 0 && (
                          <div className="mb-3">
                            <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2 ml-7">Tool Calls</p>
                            <div className="ml-7 space-y-1">
                              {node.toolCalls.map((tc, i) => (
                                <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-slate-100">
                                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                    tc.status === 'VERIFIED' ? 'bg-green-500' : tc.status === 'pending' ? 'bg-slate-300' : 'bg-red-500'
                                  }`} />
                                  <span className="text-[10px] font-bold text-slate-700">{tc.tool?.replace(/_/g, ' ')}</span>
                                  <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase ml-auto ${
                                    tc.status === 'VERIFIED' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                                  }`}>{tc.status}</span>
                                  {tc.error && <span className="text-[9px] text-red-500 font-mono truncate max-w-[200px]">{tc.error}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Event log */}
                        {node.logs.length > 0 && (
                          <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2 ml-7">Event Log</p>
                            <div className="ml-7 space-y-1">
                              {node.logs.map((log, i) => (
                                <div key={i} className="flex items-start gap-2 px-3 py-1.5 bg-white rounded-lg border border-slate-100">
                                  {log.type === 'tool_start' && <span className="mt-0.5 w-2 h-2 border border-slate-300 border-t-red-500 rounded-full animate-spin flex-shrink-0" />}
                                  {log.type === 'tool_result' && <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${log.status === 'VERIFIED' ? 'bg-green-500' : 'bg-red-500'}`} />}
                                  {log.type === 'llm_start' && <span className="mt-0.5 w-2 h-2 border border-blue-300 border-t-blue-600 rounded-full animate-spin flex-shrink-0" />}
                                  {log.type === 'llm_done' && <span className="mt-0.5 w-2 h-2 bg-blue-500 rounded-full flex-shrink-0" />}
                                  <div className="min-w-0 flex-grow">
                                    <p className="text-[10px] text-slate-600 truncate">{log.message}</p>
                                    {log.preview && (
                                      <p className="text-[9px] text-slate-400 italic mt-0.5 line-clamp-2">{log.preview}</p>
                                    )}
                                  </div>
                                  <span className="text-[8px] font-mono text-slate-300 flex-shrink-0 mt-0.5">
                                    {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Summary / LLM preview */}
                        {node.llmPreview && (
                          <div className="ml-7 mt-2 p-3 bg-blue-50 border border-blue-100 rounded-lg">
                            <p className="text-[9px] font-black uppercase tracking-widest text-blue-500 mb-1">LLM Output</p>
                            <p className="text-[10px] text-blue-800 leading-relaxed">{node.llmPreview}</p>
                          </div>
                        )}

                        {/* Empty state */}
                        {node.toolCalls.length === 0 && node.logs.length === 0 && (
                          <p className="text-[10px] text-slate-400 italic ml-7 py-2">No activity recorded yet.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Deltas section */}
            {workflowRun.deltas.length > 0 && (
              <div className="px-6 py-4 border-t border-slate-200 bg-slate-50">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">Changes Detected ({workflowRun.deltas.length})</p>
                <div className="space-y-1">
                  {workflowRun.deltas.map((d, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-slate-100">
                      <span className={`text-[8px] px-1.5 py-0.5 rounded font-black uppercase flex-shrink-0 ${
                        d.significance === 'HIGH' ? 'bg-red-100 text-red-700' :
                        d.significance === 'MEDIUM' ? 'bg-amber-100 text-amber-700' :
                        'bg-slate-100 text-slate-500'
                      }`}>{d.significance}</span>
                      <span className="text-[10px] font-bold text-slate-600">{d.category}</span>
                      <span className="text-[10px] text-slate-500 truncate">{d.change}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Run summary */}
            {workflowRun.runSummary && (
              <div className="px-6 py-4 border-t border-green-100 bg-green-50">
                <p className="text-[9px] font-black uppercase tracking-widest text-green-600 mb-1">Run Summary</p>
                <p className="text-xs text-green-800">{workflowRun.runSummary}</p>
              </div>
            )}
          </div>
        ) : (
          /* Pipeline Graph tab */
          <div className="flex overflow-hidden" style={{ height: '70vh' }}>
            <div className={`${graphSelectedNode ? 'w-3/5' : 'w-full'} transition-all`}>
              <PipelineFlow workflowRun={workflowRun} onNodeClick={setGraphSelectedNode} />
            </div>
            {graphSelectedNode && (() => {
              const node = workflowRun.nodes.find(n => n.id === graphSelectedNode);
              if (!node) return null;
              return (
                <div className="w-2/5 border-l border-slate-200 overflow-y-auto custom-scrollbar bg-slate-50">
                  <div className="px-5 py-4 border-b border-slate-100 bg-white flex items-center justify-between sticky top-0 z-10">
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                        node.status === 'completed' ? 'bg-green-500' :
                        node.status === 'running' ? 'bg-red-500 animate-pulse' :
                        node.status === 'failed' ? 'bg-red-500' : 'bg-slate-300'
                      }`} />
                      <h4 className="text-sm font-bold text-slate-800">{node.label}</h4>
                      <span className={`text-[8px] px-2 py-0.5 rounded-full font-bold uppercase ${
                        node.status === 'completed' ? 'bg-green-100 text-green-700' :
                        node.status === 'running' ? 'bg-red-100 text-red-700' :
                        node.status === 'failed' ? 'bg-red-100 text-red-600' :
                        'bg-slate-100 text-slate-500'
                      }`}>{node.status}</span>
                    </div>
                    <button onClick={() => setGraphSelectedNode(null)} className="p-1 hover:bg-slate-100 rounded transition-colors text-slate-400">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                  <div className="p-5 space-y-4">
                    {node.toolCalls.length > 0 && (
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">Tool Calls ({node.toolCalls.length})</p>
                        <div className="space-y-1">
                          {node.toolCalls.map((tc, i) => (
                            <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-slate-100">
                              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                tc.status === 'VERIFIED' ? 'bg-green-500' : tc.status === 'pending' ? 'bg-slate-300' : 'bg-red-500'
                              }`} />
                              <span className="text-[10px] font-bold text-slate-700">{tc.tool?.replace(/_/g, ' ')}</span>
                              <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase ml-auto ${
                                tc.status === 'VERIFIED' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                              }`}>{tc.status}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {node.logs.length > 0 && (
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">Event Log ({node.logs.length})</p>
                        <div className="space-y-1">
                          {node.logs.map((log, i) => (
                            <div key={i} className="flex items-start gap-2 px-3 py-1.5 bg-white rounded-lg border border-slate-100">
                              {log.type === 'tool_start' && <span className="mt-0.5 w-2 h-2 border border-slate-300 border-t-red-500 rounded-full animate-spin flex-shrink-0" />}
                              {log.type === 'tool_result' && <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${log.status === 'VERIFIED' ? 'bg-green-500' : 'bg-red-500'}`} />}
                              {log.type === 'llm_start' && <span className="mt-0.5 w-2 h-2 border border-blue-300 border-t-blue-600 rounded-full animate-spin flex-shrink-0" />}
                              {log.type === 'llm_done' && <span className="mt-0.5 w-2 h-2 bg-blue-500 rounded-full flex-shrink-0" />}
                              <div className="min-w-0 flex-grow">
                                <p className="text-[10px] text-slate-600">{log.message}</p>
                                {log.preview && <p className="text-[9px] text-slate-400 italic mt-0.5 line-clamp-3">{log.preview}</p>}
                              </div>
                              <span className="text-[8px] font-mono text-slate-300 flex-shrink-0 mt-0.5">
                                {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {node.llmPreview && (
                      <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg">
                        <p className="text-[9px] font-black uppercase tracking-widest text-blue-500 mb-1">LLM Output</p>
                        <p className="text-[10px] text-blue-800 leading-relaxed">{node.llmPreview}</p>
                      </div>
                    )}
                    {node.toolCalls.length === 0 && node.logs.length === 0 && (
                      <p className="text-[10px] text-slate-400 italic py-4 text-center">No activity recorded yet.</p>
                    )}
                  </div>
                </div>
              );
            })()}</div>
        )}
      </div>
    </div>
  );
};

export default App;
