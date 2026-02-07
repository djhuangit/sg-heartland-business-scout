
import { AreaAnalysis, Recommendation } from '../types';

const API_BASE = 'http://localhost:8000/api';

export const fetchAnalysis = async (town: string): Promise<AreaAnalysis> => {
  const res = await fetch(`${API_BASE}/scout/${town}/analysis`);
  if (!res.ok) throw new Error(`No analysis for ${town}`);
  return res.json();
};

export const fetchTowns = async (): Promise<Array<{ name: string; has_analysis: boolean; total_runs: number; last_run_at: string | null }>> => {
  const res = await fetch(`${API_BASE}/towns`);
  const data = await res.json();
  return data.towns;
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
