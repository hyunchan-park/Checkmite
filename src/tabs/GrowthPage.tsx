import { useState, useEffect } from 'react';
import './GrowthPage.css';
import { Badge } from '../components/Badge';
import { BoxSelector } from '../components/BoxSelector';
import { Icon } from '../components/Icons';
import { LineChart } from '../components/LineChart';
import { api } from '../api/client';
import type { GrowthResult } from '../api/client';
import type { CultureBox, Measurement } from '../types';

interface GrowthPageProps {
  boxes: CultureBox[];
  selectedBoxId: string;
  onBoxChange: (id: string) => void;
  onBoxCreate: (box: Omit<CultureBox, 'id'>) => Promise<void> | void;
}

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function numberValue(value: number | undefined, digits = 0) {
  if (value === undefined || value === null) return '-';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signedNumberValue(value: number | undefined, digits = 0) {
  if (value === undefined || value === null) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${numberValue(value, digits)}`;
}

function signedPercentValue(value: number | undefined, digits = 1) {
  if (value === undefined || value === null) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${numberValue(value, digits)}%`;
}

type AnalysisHistory = {
  key: string;
  measuredAt: string;
  types: Set<Measurement['type']>;
  countValue?: number;
  detectionCount?: number;
  densityPerLiter?: number;
  vitalityScore?: number;
  activeRatio?: number;
};

const MERGE_WINDOW_MS = 5 * 60 * 1000;

function compactAnalysisHistory(measurements: Measurement[]) {
  const sorted = measurements
    .slice()
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime());

  return sorted.reduce<AnalysisHistory[]>((groups, item) => {
    const measuredAtMs = new Date(item.measuredAt).getTime();
    const latest = groups[groups.length - 1];
    const latestMs = latest ? new Date(latest.measuredAt).getTime() : 0;
    const sameAnalysis = latest && Math.abs(measuredAtMs - latestMs) <= MERGE_WINDOW_MS;
    const group = sameAnalysis
      ? latest
      : {
          key: `${item.measuredAt}-${item.id}`,
          measuredAt: item.measuredAt,
          types: new Set<Measurement['type']>(),
        };

    if (!sameAnalysis) groups.push(group);

    group.types.add(item.type);
    if (measuredAtMs < new Date(group.measuredAt).getTime()) {
      group.measuredAt = item.measuredAt;
    }
    if (item.type === 'detection') {
      group.detectionCount = item.countValue;
    }
    if (item.type === 'density') {
      group.densityPerLiter = item.densityPerLiter;
    }
    if (item.type === 'vitality') {
      group.vitalityScore = item.vitalityScore;
      group.activeRatio = item.activeRatio;
    }
    group.countValue = group.densityPerLiter ?? group.detectionCount ?? group.countValue;

    return groups;
  }, []);
}

function historyTypeLabel(types: Set<Measurement['type']>) {
  if (types.has('density') && types.has('vitality')) return '통합 분석';
  if (types.has('density') && types.has('detection')) return '탐지·밀도';
  if (types.has('detection')) return '객체 탐지';
  if (types.has('density')) return '밀도 분석';
  if (types.has('vitality')) return '활력도';
  return '분석';
}

function growthStatus(rate: number | undefined, hasComparison: boolean) {
  if (!hasComparison || rate === undefined || rate === null) return '비교 데이터 부족';
  if (rate > 20) return '최근 증식 활발';
  if (rate < -10) return '최근 감소 추세';
  return '최근 유지 관찰';
}

function countGrowthTrend(growth: GrowthResult | null) {
  const trend = growth?.countTrend ?? [];
  const first = trend[0]?.countValue ?? 0;
  if (first <= 0) return [];
  return trend.map((point) => ((point.countValue - first) / first) * 100);
}

export function GrowthPage({
  boxes,
  selectedBoxId,
  onBoxChange,
  onBoxCreate,
}: GrowthPageProps) {
  const box = boxes.find((item) => item.id === selectedBoxId) ?? boxes[0];
  const [growth, setGrowth] = useState<GrowthResult | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [expandedCard, setExpandedCard] = useState<'count' | 'vitality' | 'trend' | 'densityTrend' | 'vitalityTrend' | null>(null);

  useEffect(() => {
    if (!box?.id) return;
    setGrowth(null);
    setMeasurements([]);
    Promise.all([
      api.getGrowth(box.id).catch(() => null),
      api.listMeasurements(box.id).catch(() => []),
    ]).then(([g, m]) => {
      setGrowth(g);
      setMeasurements(m as Measurement[]);
    });
  }, [box?.id]);

  const growthRateTrend = countGrowthTrend(growth);
  const analysisHistory = compactAnalysisHistory(measurements);
  const firstCountDate = growth?.countTrend[0]?.date;
  const latestCountDate = growth?.countTrend[growth.countTrend.length - 1]?.date;
  const previousCountDate = growth?.countTrend[growth.countTrend.length - 2]?.date;
  const hasRecentComparison = Boolean(previousCountDate);
  const growthLabel = growthStatus(growth?.recentWeightedGrowthRatePercent, hasRecentComparison);
  const growthBadge =
    growthLabel === '최근 증식 활발' ? 'high' : growthLabel === '최근 감소 추세' ? 'low' : 'mid';

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-eyebrow"><span className="pe-dot" />증식률 분석 · GROWTH</div>
        <h1 className="page-title">마리 / 1L · 활력도 기반 증식률 분석</h1>
        <p className="page-desc">사육 박스별 마리 / 1L와 활력도 변화를 3:1 가중치로 반영하고, 직전 측정 대비 변화도 함께 관찰합니다.</p>
      </div>

      <div className="growth-selector">
        <BoxSelector boxes={boxes} value={box?.id ?? ''} onChange={onBoxChange} onCreate={onBoxCreate} />
      </div>

      <div className={`card growth-hero growth-hero-${growthBadge}`}>
        <div className="card-head">
          <div className="card-title">대표 증식률</div>
          <span className="growth-hero-period">{growth ? `${growth.from} → ${growth.to} / ${growth.days}일` : ''}</span>
        </div>
        <div className={`growth-hero-label growth-hero-label-${growthBadge}`}>
          {growthLabel}
        </div>
        <div className="growth-primary-metrics">
          <div className="growth-primary-card growth-primary-card-main">
            <div className="growth-primary-label">직전 측정 대비 증식률</div>
            <strong className="growth-primary-value tnum">
              {previousCountDate ? signedPercentValue(growth?.recentWeightedGrowthRatePercent) : '-'}
            </strong>
            <span>
              {growth && previousCountDate && latestCountDate
                ? `${previousCountDate} 대비 ${latestCountDate}`
                : '직전 비교를 위한 측정 2회 이상 필요'}
            </span>
          </div>
          <div className="growth-primary-card">
            <div className="growth-primary-label">첫 측정 대비 증식률</div>
            <strong className="growth-primary-value tnum">
              {signedPercentValue(growth?.weightedGrowthRatePercent)}
            </strong>
            <span>
              {growth && firstCountDate && latestCountDate
                ? `${firstCountDate} 대비 ${latestCountDate}`
                : 'density 측정 2회 이상 필요'}
            </span>
          </div>
        </div>
        <div className="growth-current-metrics">
          <div className="growth-current-card">
            <span>현재 밀도</span>
            <strong className="tnum">{growth && growth.currentDensityPerLiter > 0 ? numberValue(growth.currentDensityPerLiter) : '-'}<small>마리 / 1L</small></strong>
          </div>
          <div className="growth-current-card">
            <span>현재 활력도</span>
            <strong className="tnum">{growth && growth.latestVitalityScore > 0 ? numberValue(growth.latestVitalityScore, 1) : '-'}<small>점</small></strong>
          </div>
        </div>
      </div>

      <div className={`growth-sub${expandedCard ? ' growth-sub-has-expanded' : ' grid growth-sub-grid'}`}>
        {(['count', 'vitality', 'trend', 'densityTrend', 'vitalityTrend'] as const).map((key) => {
          const isExpanded = expandedCard === key;
          const toggle = () => setExpandedCard(isExpanded ? null : key);
          return (
            <div
              key={key}
              className={`card growth-sub-card${isExpanded ? ' expanded' : ''}`}
              role="button"
              tabIndex={0}
              onClick={toggle}
              onKeyDown={(e) => e.key === 'Enter' && toggle()}
            >
              <div className="card-head">
                <div className="card-title">
                  {key === 'count' && '현재 마리 / 1L'}
                  {key === 'vitality' && '현재 활력도'}
                  {key === 'trend' && '증식률 그래프'}
                  {key === 'densityTrend' && '밀도 그래프'}
                  {key === 'vitalityTrend' && '활력도 그래프'}
                </div>
                <span className="growth-expand-icon">
                  {isExpanded ? <Icon name="x" /> : <Icon name="scan" />}
                </span>
              </div>

              {key === 'count' && (
                <>
                  <div className="stat-value tnum">
                    {growth && growth.currentCount > 0 ? numberValue(growth.currentCount) : '-'}
                    <small>마리 / 1L</small>
                  </div>
                  <div className="stat-sub">{growth?.to ?? '측정 필요'}</div>
                  {isExpanded && (
                    <div className="growth-sub-detail">
                      <span>초기 {numberValue(growth?.firstCount)} 마리 / 1L</span>
                      <span>누적 변화 {signedNumberValue(growth?.countChange)} 마리 / 1L</span>
                      <span>직전 {numberValue(growth?.previousCount)} 마리 / 1L</span>
                      <span>최근 변화 {signedNumberValue(growth?.recentCountChange)} 마리 / 1L</span>
                    </div>
                  )}
                </>
              )}

              {key === 'vitality' && (
                <>
                  <div className="stat-value tnum">
                    {growth && growth.latestVitalityScore > 0 ? numberValue(growth.latestVitalityScore, 1) : '-'}
                    <small>점</small>
                  </div>
                  <div className="stat-sub">평균 {numberValue(growth?.averageVitalityScore, 1)}점</div>
                  {isExpanded && (
                    <div className="growth-sub-detail">
                      <span>초기 {numberValue(growth?.firstVitalityScore, 1)}점</span>
                      <span>직전 {numberValue(growth?.previousVitalityScore, 1)}점</span>
                      <span>최근 변화 {signedNumberValue(growth?.recentVitalityChange, 1)}점</span>
                      <span>최근 변화율 {signedPercentValue(growth?.recentVitalityChangeRatePercent)}</span>
                    </div>
                  )}
                </>
              )}

              {key === 'trend' && (
                <>
                  {growthRateTrend.length > 1
                    ? <LineChart data={growthRateTrend} xlabel="측정" height={isExpanded ? 300 : 180} />
                    : <div className="growth-empty">증식률 추이를 보려면 density 측정 데이터가 더 필요합니다.</div>}
                  {isExpanded && (
                    <div className="growth-sub-detail">
                      <span>기준 {numberValue(growth?.firstCount)} 마리 / 1L</span>
                      <span>현재 {numberValue(growth?.currentCount)} 마리 / 1L</span>
                      <span>첫 측정 대비 {signedPercentValue(growth?.countChangeRatePercent)}</span>
                      <span>직전 측정 대비 {signedPercentValue(growth?.recentCountChangeRatePercent)}</span>
                    </div>
                  )}
                </>
              )}

              {key === 'densityTrend' && (
                <>
                  {(growth?.densityTrend?.length ?? 0) > 1
                    ? <LineChart data={growth!.densityTrend.map((point) => point.densityPerLiter)} xlabel="측정" height={isExpanded ? 300 : 180} />
                    : <div className="growth-empty">밀도 추이를 보려면 density 측정 데이터가 더 필요합니다.</div>}
                  {isExpanded && (
                    <div className="growth-sub-detail">
                      <span>초기 {numberValue(growth?.firstDensityPerLiter)} 마리 / 1L</span>
                      <span>현재 {numberValue(growth?.currentDensityPerLiter)} 마리 / 1L</span>
                      <span>직전 대비 {signedPercentValue(growth?.recentCountChangeRatePercent)}</span>
                    </div>
                  )}
                </>
              )}

              {key === 'vitalityTrend' && (
                <>
                  {(growth?.vitalityTrend?.length ?? 0) > 1
                    ? <LineChart data={growth!.vitalityTrend.map((point) => point.score)} xlabel="측정" height={isExpanded ? 300 : 180} />
                    : <div className="growth-empty">활력도 추이를 보려면 vitality 측정 데이터가 더 필요합니다.</div>}
                  {isExpanded && (
                    <div className="growth-sub-detail">
                      <span>초기 {numberValue(growth?.firstVitalityScore, 1)}점</span>
                      <span>현재 {numberValue(growth?.latestVitalityScore, 1)}점</span>
                      <span>직전 대비 {signedPercentValue(growth?.recentVitalityChangeRatePercent)}</span>
                    </div>
                  )}
                </>
              )}


            </div>
          );
        })}
      </div>

      <div className="card growth-table-card">
        <div className="card-head">
          <div className="card-title">분석 이력</div>
          <span className="card-sub">같은 영상/시간대의 탐지·밀도·활력도를 한 회차로 표시</span>
        </div>
        <div className="growth-table">
          <div className="growth-row growth-row-head">
            <span>날짜</span>
            <span>분석</span>
            <span>마리 / 1L</span>
            <span>활력도</span>
          </div>
          {analysisHistory.length === 0 && (
            <div className="growth-empty" style={{ padding: '20px 0' }}>측정 이력이 없습니다.</div>
          )}
          {analysisHistory
            .map((item) => (
              <div className="growth-row" key={item.key}>
                <span>{dateOnly(item.measuredAt)}</span>
                <span>
                  <Badge kind={item.types.has('density') ? 'high' : 'neutral'}>{historyTypeLabel(item.types)}</Badge>
                </span>
                <span className="mono">{item.countValue?.toLocaleString() ?? '-'}</span>
                <span className="mono">{item.vitalityScore?.toFixed(1) ?? '-'}</span>
              </div>
            ))}
        </div>
      </div>

    </div>
  );
}
