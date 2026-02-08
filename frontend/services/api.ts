
import { AreaAnalysis, Recommendation, RunSummary, RunDetail, TownSummary } from '../types';

const API_BASE = 'http://localhost:8000/api';

export const fetchAnalysis = async (town: string): Promise<AreaAnalysis> => {
  const res = await fetch(`${API_BASE}/scout/${town}/analysis`);
  if (!res.ok) throw new Error(`No analysis for ${town}`);
  return res.json();
};

export const fetchTowns = async (): Promise<TownSummary[]> => {
  const res = await fetch(`${API_BASE}/towns`);
  const data = await res.json();
  return data.towns;
};

export const clearTownCache = async (town: string): Promise<void> => {
  await fetch(`${API_BASE}/scout/${town}/cache`, { method: 'DELETE' });
};

export const generateSpecificDossier = async (
  town: string,
  businessType: string,
): Promise<Recommendation> => {
  const res = await fetch(`${API_BASE}/dossier/${town}?business_type=${encodeURIComponent(businessType)}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Dossier generation failed');
  return res.json();
};

export const createScoutStream = (town: string): EventSource => {
  return new EventSource(`${API_BASE}/scout/${town}/stream`);
};

export const fetchRunHistory = async (town?: string, limit: number = 50): Promise<{ runs: RunSummary[]; total: number }> => {
  const params = new URLSearchParams();
  if (town) params.set('town', town);
  params.set('limit', String(limit));
  const res = await fetch(`${API_BASE}/runs?${params}`);
  return res.json();
};

export const fetchRunDetail = async (runId: string): Promise<RunDetail> => {
  const res = await fetch(`${API_BASE}/runs/${runId}`);
  if (!res.ok) throw new Error(`Run ${runId} not found`);
  return res.json();
};
