import type { CultureBox, Measurement, TrashedCultureBox } from '../types';

const BASE = '/api';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface DetectionResult {
  measurementId: string;
  boxId: string;
  type: 'detection';
  measuredAt: string;
  detection: {
    countValue: number;
    boxes: Array<{ className: string; confidence: number; x: number; y: number; width: number; height: number }>;
  };
  measurement: Partial<Measurement>;
}

export interface DensityResult {
  measurementId: string;
  vitalityMeasurementId?: string;
  boxId: string;
  type: 'density';
  measuredAt: string;
  density: {
    densityPerLiter: number;
    currentDensityPerLiter: number;
    estimatedCountPerMl: number;
    bestFrameCount: number;
    peakCount: number;
    averageFrameCount?: number;
    sampleCount?: number;
    sampledFrames?: number;
    videoDurationSeconds?: number;
    analysisWindowSeconds?: number;
    selectedFrameIndex?: number;
    selectedFrameTimestampSeconds?: number;
    selectedFrameQuality?: {
      sharpness: number;
      brightness: number;
      quality_score: number;
      passes_quality: boolean;
    };
    densityGrade?: string;
    warnings?: string[];
    qualityWarningSummary?: { count: number; sampleIndices: number[]; message: string } | null;
  };
  vitality?: {
    score: number;
    activeRatio?: number | null;
    averageSpeedMmPerSec?: number | null;
    averageSpeedRatio?: number | null;
    notice?: {
      level: 'normal' | 'caution' | 'danger';
      label: string;
      message: string;
    } | null;
    trend: number[];
    sampleCount?: number;
    confirmedTracks?: number;
    movingTracks?: number;
    trackingVideoUrl?: string | null;
    representativeTrack?: {
      sampleIndex: number;
      originalName: string;
      trackId: number;
      framesSeen?: number;
      firstFrameIndex?: number;
      lastFrameIndex?: number;
      totalDistancePx?: number;
      totalDistanceMm?: number;
      meanSpeedPxPerSec?: number;
      meanSpeedMmPerSec?: number;
      meanSpeedRatio?: number;
      movingRatio?: number;
      vitalityScore?: number;
      visibilityRatio?: number;
      averageConfidence?: number;
      isLiveMotion: boolean;
    } | null;
  };
  previous?: {
    density?: { measurementId: string; measuredAt: string; densityPerLiter?: number; countValue?: number } | null;
    vitality?: { measurementId: string; measuredAt: string; score?: number; activeRatio?: number | null } | null;
  };
  measurement: Partial<Measurement>;
  vitalityMeasurement?: Partial<Measurement>;
  samples?: Array<{
    sampleIndex: number;
    originalName: string;
    bestFrameCount?: number;
    estimatedCountPerMl?: number;
    densityPerLiter?: number;
    averageFrameCount?: number;
    selectedFrameIndex?: number;
    vitalityScore?: number;
    activeRatio?: number | null;
    averageSpeedMmPerSec?: number | null;
    averageSpeedRatio?: number | null;
    confirmedTracks?: number;
    movingTracks?: number;
    trackingVideoUrl?: string | null;
  }>;
}

export interface DensityProgress {
  id: string;
  type: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  percent: number;
  message: string;
  currentSample: number;
  totalSamples: number;
  samples: Array<{
    sampleIndex: number;
    status: string;
    originalName?: string;
    bestFrameCount?: number;
    estimatedCountPerMl?: number;
    vitalityScore?: number;
    activeRatio?: number | null;
    confirmedTracks?: number;
    movingTracks?: number;
    trackingVideoUrl?: string | null;
    error?: string;
  }>;
  result: DensityResult | null;
  error: string | null;
  updatedAt?: string;
}

export interface VitalityResult {
  measurementId: string;
  boxId: string;
  type: 'vitality';
  measuredAt: string;
  vitality: {
    score: number;
    activeRatio: number;
    trend: number[];
  };
  measurement: Partial<Measurement>;
}

export interface GrowthResult {
  boxId: string;
  from: string;
  to: string;
  days: number;
  currentCount: number;
  firstCount: number;
  countChange: number;
  countChangeRatePercent: number;
  countGrowthPerDay: number;
  logCountGrowthPerDay: number;
  previousCount: number;
  recentCountChange: number;
  recentCountChangeRatePercent: number;
  currentDensityPerLiter: number;
  firstDensityPerLiter: number;
  densityChangePerLiter: number;
  densityChangeRatePercent: number;
  densityGrowthPerDay: number;
  logDensityGrowthPerDay: number;
  latestVitalityScore: number;
  firstVitalityScore: number;
  averageVitalityScore: number;
  vitalityChange: number;
  vitalityChangeRatePercent: number;
  previousVitalityScore: number;
  recentVitalityChange: number;
  recentVitalityChangeRatePercent: number;
  weightedGrowthRatePercent: number;
  recentWeightedGrowthRatePercent: number;
  recentDropDetected: boolean;
  recentDropThresholdPercent: number;
  countWeight: number;
  vitalityWeight: number;
  growthLabel: string;
  countTrend: Array<{ date: string; countValue: number }>;
  densityTrend: Array<{ date: string; densityPerLiter: number }>;
  vitalityTrend: Array<{ date: string; score: number }>;
}

export const api = {
  listBoxes: () => req<CultureBox[]>('/culture-boxes'),
  createBox: (data: Omit<CultureBox, 'id'>) =>
    req<CultureBox>('/culture-boxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  updateBox: (id: string, data: Partial<Omit<CultureBox, 'id'>>) =>
    req<CultureBox>(`/culture-boxes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteBox: (id: string) =>
    req<{ box: CultureBox; measurements: Measurement[] }>(`/culture-boxes/${id}`, { method: 'DELETE' }),

  listTrash: () => req<TrashedCultureBox[]>('/trash/culture-boxes'),
  restoreBox: (id: string) =>
    req<{ box: CultureBox; measurements: Measurement[] }>(`/trash/culture-boxes/${id}/restore`, { method: 'POST' }),

  listMeasurements: (boxId: string) =>
    req<Measurement[]>(`/culture-boxes/${boxId}/measurements`),
  getGrowth: (boxId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    return req<GrowthResult>(`/culture-boxes/${boxId}/growth${qs ? `?${qs}` : ''}`);
  },

  analyzeDetection: (boxId: string, file: File) => {
    const form = new FormData();
    form.append('boxId', boxId);
    form.append('file', file);
    return req<DetectionResult>('/analysis/detection', { method: 'POST', body: form });
  },
  startDensityAnalysis: (boxId: string, files: File[], onUploadProgress?: (percent: number) => void) => {
    const form = new FormData();
    form.append('boxId', boxId);
    files.forEach((file) => form.append('files', file));
    return new Promise<DensityProgress>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/analysis/density`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onUploadProgress) {
          onUploadProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onload = () => {
        const body = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as DensityProgress);
        } else {
          reject(new Error((body as { message?: string }).message ?? `HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error('업로드 요청에 실패했습니다.'));
      xhr.send(form);
    });
  },
  getDensityProgress: (jobId: string) =>
    req<DensityProgress>(`/analysis/density/${jobId}/progress`),
  analyzeVitality: (boxId: string, file: File) => {
    const form = new FormData();
    form.append('boxId', boxId);
    form.append('file', file);
    return req<VitalityResult>('/analysis/vitality', { method: 'POST', body: form });
  },
};
