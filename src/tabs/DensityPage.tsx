import { useState, useRef } from 'react';
import './DensityPage.css';
import { Icon } from '../components/Icons';
import { FileChip } from '../components/FileChip';
import { Processing } from '../components/Processing';
import { Badge, gradeOf } from '../components/Badge';
import { BoxSelector } from '../components/BoxSelector';
import { api } from '../api/client';
import type { DensityProgress, DensityResult } from '../api/client';
import type { CultureBox, PhaseId } from '../types';

const DEN_STEPS = [
  '1 mL 배지 영상 확인…',
  '10초 미만/빈 영상 자동 제외…',
  '영상별 좋은 프레임 선별…',
  '업로드 배지 count 평균 및 활력도 산출…',
  '통합 분석 결과 저장…',
];

function fileMeta(file: File) {
  const mb = (file.size / 1024 / 1024).toFixed(1);
  return `${mb} MB`;
}

function getVideoDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('영상 길이를 확인할 수 없습니다.'));
    };
    video.src = url;
  });
}

interface DensityResultViewProps {
  data: DensityResult;
  onReset: () => void;
}


function formatSigned(value: number, digits = 0) {
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString()}`;
}

function formatPercentChange(previous?: number | null, current?: number | null) {
  if (previous == null || current == null || previous === 0) return null;
  const value = ((current - previous) / previous) * 100;
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function metricDelta(previous?: number | null, current?: number | null, digits = 0) {
  if (previous == null || current == null) return '-';
  const diff = current - previous;
  const percent = formatPercentChange(previous, current);
  return percent ?? formatSigned(diff, digits);
}

function vitalityNotice(vitality: DensityResult['vitality']) {
  if (vitality?.notice) return vitality.notice;
  if (vitality?.averageSpeedRatio == null) return null;
  const ratio = vitality.averageSpeedRatio;
  if (ratio <= 2) {
    return {
      level: 'danger' as const,
      label: '위험',
      message: `천적응애 평균속도가 먹이응애 기준 ${ratio.toFixed(2)}x입니다. 2x 이하이면 활력 저하 위험으로 즉시 확인이 필요합니다.`,
    };
  }
  if (ratio <= 3) {
    return {
      level: 'caution' as const,
      label: '주의',
      message: `천적응애 평균속도가 먹이응애 기준 ${ratio.toFixed(2)}x입니다. 3x 이하이면 활력 저하 가능성을 관찰해야 합니다.`,
    };
  }
  return {
    level: 'normal' as const,
    label: '정상 관찰',
    message: `천적응애 평균속도가 먹이응애 기준 ${ratio.toFixed(2)}x입니다.`,
  };
}

function DensityResultView({ data, onReset }: DensityResultViewProps) {
  const density = data.density;
  const vitality = data.vitality;
  const previousDensity = data.previous?.density?.densityPerLiter;
  const previousVitality = data.previous?.vitality?.score;
  const perLiter = density.currentDensityPerLiter.toLocaleString();
  const densityLevel = density.densityGrade === 'marketable' ? '상품성 있음' : '낮음';
  const activeRatioPct = vitality?.activeRatio != null ? Math.round(vitality.activeRatio * 100) : null;
  const notice = vitalityNotice(vitality);
  const noticeLevel = notice?.level ?? 'normal';
  const densityDelta = metricDelta(previousDensity, density.currentDensityPerLiter);
  const vitalityDelta = metricDelta(previousVitality, vitality?.score, 1);

  return (
    <div className="fade-in grid">
      <div className={`card vitality-hero-${noticeLevel}`}>
        <div className="card-head">
          <div className="card-title">통합 분석 요약</div>
          <Badge kind="accent" dot>완료</Badge>
        </div>
        <div className="summary-metrics summary-metrics-priority">
          <div className="summary-metric summary-metric-primary">
            <span className="sm-label">현재 밀도</span>
            <strong className="tnum">{perLiter}<small>마리/L</small></strong>
          </div>
          <div className="summary-metric summary-metric-primary">
            <span className="sm-label">현재 활력도</span>
            <strong className="tnum">{vitality?.score ?? '-'}<small>점</small></strong>
            <div className="sm-secondary-wrap">
              <span>먹이응애 기준 속도</span>
              <strong className="tnum sm-secondary">{vitality?.averageSpeedRatio != null ? vitality.averageSpeedRatio.toFixed(2) : '-'}<small>x</small></strong>
            </div>
          </div>
          <div className="summary-metric summary-metric-previous">
            <span className="sm-label">직전 밀도</span>
            <strong className="tnum">{previousDensity != null ? previousDensity.toLocaleString() : '-'}<small>마리/L</small></strong>
          </div>
          <div className="summary-metric summary-metric-previous">
            <span className="sm-label">직전 활력도</span>
            <strong className="tnum">{previousVitality != null ? previousVitality.toFixed(1) : '-'}<small>점</small></strong>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="stat">
          <div className="stat-label">현재 count</div>
          <div className="stat-value tnum">
            {density.estimatedCountPerMl.toLocaleString()}<small>마리/mL</small>
          </div>
          <div className="stat-sub">최대 프레임 {density.bestFrameCount}마리</div>
        </div>
        <div className="stat">
          <div className="stat-label">이번 변화</div>
          <div className="stat-value tnum change-pair"><span>밀도 {densityDelta}</span><span>활력도 {vitalityDelta}</span></div>
          <div className="stat-sub">직전 측정 대비</div>
        </div>
      </div>

      {/* 밀도 정보 · 활력도 세부 */}
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <div className="card-title">밀도 정보</div>
            <Badge kind={gradeOf(densityLevel)} dot>{densityLevel}</Badge>
          </div>
          <div className="metric-row"><span className="mr-k">L당 밀도</span><span className="mr-v mono">{perLiter} 마리/L</span></div>
          <div className="metric-row"><span className="mr-k">평균 count</span><span className="mr-v mono">{density.averageFrameCount?.toFixed(1) ?? '-'} 마리</span></div>
          <div className="metric-row"><span className="mr-k">분석 영상 수</span><span className="mr-v mono">{density.sampleCount ?? data.samples?.length ?? 0}개</span></div>
          {density.qualityWarningSummary && (
            <div className="quality-note">
              {density.qualityWarningSummary.message}
              <span>샘플 {density.qualityWarningSummary.sampleIndices.join(', ')}</span>
            </div>
          )}
          {(density.warnings?.length ?? 0) > 0 && (
            <div className="quality-note quality-note-warn">
              추가 경고 {density.warnings?.length}건이 있습니다.
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <div className="card-title">활력도 세부</div>
          </div>
          {activeRatioPct != null && (
            <div className="metric-row"><span className="mr-k">활동 개체 비율</span><span className="mr-v mono">{activeRatioPct}%</span></div>
          )}
          {vitality?.averageSpeedMmPerSec != null && (
            <div className="metric-row"><span className="mr-k">평균 속도</span><span className="mr-v mono">{vitality.averageSpeedMmPerSec.toFixed(3)} mm/s</span></div>
          )}
          {vitality?.averageSpeedRatio != null && (
            <div className="metric-row"><span className="mr-k">먹이응애 기준 속도</span><span className="mr-v mono">{vitality.averageSpeedRatio.toFixed(2)}x</span></div>
          )}
          <div className="metric-row"><span className="mr-k">확정 track</span><span className="mr-v mono">{vitality?.confirmedTracks ?? '-'}개</span></div>
          <div className="metric-row"><span className="mr-k">이동 track</span><span className="mr-v mono">{vitality?.movingTracks ?? '-'}개</span></div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn btn-ghost btn-block" onClick={onReset}><Icon name="upload" />새 영상 분석</button>
      </div>

      {vitality?.trackingVideoUrl && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head">
            <div className="card-title">트래킹 영상</div>
            <span className="card-sub">1번 영상 기준</span>
          </div>
          <div style={{ borderRadius: 8, overflow: 'hidden', background: '#050608' }}>
            <video
              src={vitality.trackingVideoUrl}
              controls
              muted
              playsInline
              style={{ display: 'block', width: '100%', maxHeight: 620, objectFit: 'contain' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface DensityPageProps {
  boxes: CultureBox[];
  selectedBoxId: string;
  onBoxChange: (id: string) => void;
  onBoxCreate: (box: Omit<CultureBox, 'id'>) => Promise<void> | void;
}

export function DensityPage({ boxes, selectedBoxId, onBoxChange, onBoxCreate }: DensityPageProps) {
  const [phase, setPhase] = useState<PhaseId>('idle');
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<DensityResult | null>(null);
  const [progress, setProgress] = useState<DensityProgress | null>(null);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [vidDrag, setVidDrag] = useState(false);
  const pollRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const vidDropHandlers = {
    onClick: () => fileInputRef.current?.click(),
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setVidDrag(true); },
    onDragLeave: () => setVidDrag(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setVidDrag(false); if (e.dataTransfer.files) handlePick(e.dataTransfer.files); },
  };

  const handlePick = (picked: FileList | File[]) => {
    const selected = Array.from(picked);
    const known = new Set(files.map((file) => `${file.name}-${file.size}-${file.lastModified}`));
    const nextFiles = [
      ...files,
      ...selected.filter((file) => {
        const key = `${file.name}-${file.size}-${file.lastModified}`;
        if (known.has(key)) return false;
        known.add(key);
        return true;
      }),
    ];
    setFiles(nextFiles);
    setProgress(null);
    setUploadPercent(0);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setPhase('file');
  };

  const removeFile = (indexToRemove: number) => {
    const nextFiles = files.filter((_, index) => index !== indexToRemove);
    setFiles(nextFiles);
    setProgress(null);
    setUploadPercent(0);
    setError(null);
    setPhase(nextFiles.length ? 'file' : 'idle');
  };

  const startAnalysis = () => {
    if (!files.length || !selectedBoxId) return;
    if (files.length < 1) {
      setError('밀도 측정은 1개 이상의 영상이 필요합니다.');
      return;
    }
    setError(null);
    Promise.all(files.map((file) => getVideoDuration(file).catch(() => null)))
      .then((durations) => {
        const validFiles = files.filter((file, index) => file.size > 0 && (durations[index] === null || durations[index] >= 10));
        if (validFiles.length < 1) throw new Error('분석 가능한 10초 이상 영상이 없습니다. 10초 미만이거나 빈 영상은 자동 제외됩니다.');
        return api.startDensityAnalysis(selectedBoxId, validFiles, setUploadPercent);
      })
      .then((job) => {
        setProgress(job);
        const poll = window.setInterval(async () => {
          try {
            const next = await api.getDensityProgress(job.id);
            setProgress(next);
            if (next.status === 'completed' && next.result) {
              window.clearInterval(poll);
              pollRef.current = null;
              setResult(next.result);
              setPhase('result');
            } else if (next.status === 'failed') {
              window.clearInterval(poll);
              pollRef.current = null;
              setError(next.error || '분석에 실패했습니다.');
              setPhase('file');
            }
          } catch (e) {
            window.clearInterval(poll);
            pollRef.current = null;
            setError(e instanceof Error ? e.message : '진행 상태를 가져오지 못했습니다.');
            setPhase('file');
          }
        }, 1000);
        pollRef.current = poll;
      })
      .catch((e: Error) => {
        setError(e.message);
        setPhase('file');
      });
    setPhase('proc');
  };

  const onAnimDone = () => {
    // 실제 완료는 backend progress polling으로 처리한다.
  };

  const progressTrackingUrl = progress?.samples.find((sample) => sample.trackingVideoUrl)?.trackingVideoUrl;

  const reset = () => {
    setPhase('idle');
    setFiles([]);
    setResult(null);
    setProgress(null);
    setUploadPercent(0);
    setError(null);
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-eyebrow"><span className="pe-dot" />밀도 측정 · DENSITY</div>
        <h1 className="page-title">영상 기반 통합 분석</h1>
        <p className="page-desc">1개 이상의 1 mL 배지 영상을 업로드하면 10초 미만이거나 빈 영상은 자동 제외하고, 각 영상의 처음 10초 구간으로 평균 count, L당 밀도, 활력도를 함께 산출합니다.</p>
      </div>

      <div style={{ marginBottom: 18 }}>
        <BoxSelector boxes={boxes} value={selectedBoxId} onChange={onBoxChange} onCreate={onBoxCreate} />
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger, #e55)', color: 'var(--danger, #e55)', padding: '12px 16px', fontSize: 13.5 }}>
          <Icon name="info" /> {error}
        </div>
      )}

      {phase === 'idle' && (
        <div className="grid grid-2">
          <div
            className={`vid-drop${vidDrag ? ' drag' : ''}`}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
            {...vidDropHandlers}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              multiple
              className="upload-input"
              onChange={(e) => { if (e.target.files) handlePick(e.target.files); }}
            />
            <div className="up-ic"><Icon name="video" /></div>
            <div className="up-title">영상을 끌어다 놓거나 클릭하여 업로드</div>
            <div className="up-desc">1 mL 배지 영상 · 10초 미만/빈 파일은 자동 제외 · 여러 개 동시 선택 가능</div>
            <div className="up-formats">video/* · 최대 500 MB / 파일</div>
          </div>
          <div className="card">
            <div className="card-head"><div className="card-title">측정 단계</div></div>
            <div className="metric-row"><span className="mr-k">1. 샘플</span><span className="mr-v" style={{ color: 'var(--text-2)', fontWeight: 500 }}>1개 이상 1 mL 배지</span></div>
            <div className="metric-row"><span className="mr-k">2. 밀도</span><span className="mr-v" style={{ color: 'var(--text-2)', fontWeight: 500 }}>영상별 최대 count 프레임 선택</span></div>
            <div className="metric-row"><span className="mr-k">3. 활력도</span><span className="mr-v" style={{ color: 'var(--text-2)', fontWeight: 500 }}>같은 영상의 움직임 추적</span></div>
          </div>
        </div>
      )}

      {phase === 'file' && files.length > 0 && (
        <div className="grid" style={{ maxWidth: 560 }}>
          <div className="card">
            <div className="card-head">
              <div className="card-title">선택된 영상</div>
              <Badge kind="accent">{files.length}개</Badge>
            </div>
            <div
              className={`vid-drop-add${vidDrag ? ' drag' : ''}`}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
              {...vidDropHandlers}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                multiple
                className="upload-input"
                onChange={(e) => { if (e.target.files) handlePick(e.target.files); }}
              />
              <Icon name="plus" />영상 추가 · 끌어다 놓기 가능
            </div>
            <div className="grid" style={{ gap: 8, maxHeight: 360, overflow: 'auto' }}>
              {files.map((file, index) => (
                <FileChip
                  key={`${file.name}-${file.size}-${file.lastModified}`}
                  name={`${index + 1}. ${file.name}`}
                  meta={fileMeta(file)}
                  kind="video"
                  onRemove={() => removeFile(index)}
                />
              ))}
            </div>
          </div>
          <button className="btn btn-primary btn-lg btn-block" onClick={startAnalysis}>
            <Icon name="grid" />통합 분석 시작
          </button>
        </div>
      )}

      {phase === 'proc' && (
        <>
          <Processing
            steps={DEN_STEPS}
            onDone={onAnimDone}
            percent={progress ? progress.percent : Math.min(9, Math.round(uploadPercent / 12))}
            message={progress ? progress.message : `영상 업로드 중 ${uploadPercent}%`}
            currentSample={progress?.currentSample}
            totalSamples={progress?.totalSamples ?? files.length}
          />
          {progress && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-head">
                <div className="card-title">샘플별 분석 진행</div>
                <Badge kind="accent">{progress.percent}%</Badge>
              </div>
              <div className="grid" style={{ gap: 8, maxHeight: 420, overflow: 'auto' }}>
                {progress.samples.map((sample) => (
                  <div className="metric-row" key={sample.sampleIndex}>
                    <span className="mr-k">{sample.sampleIndex}. {sample.originalName ?? '대기 중'}</span>
                    <span className="mr-v mono">
                      {sample.status}
                      {sample.estimatedCountPerMl !== undefined ? ` · ${sample.estimatedCountPerMl}마리/mL` : ''}
                      {sample.vitalityScore !== undefined ? ` · ${sample.vitalityScore.toFixed(1)}점` : ''}
                      {sample.confirmedTracks !== undefined ? ` · tracks ${sample.confirmedTracks}/${sample.movingTracks ?? 0}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {progressTrackingUrl && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-head">
                <div className="card-title">트래킹 영상 생성 중</div>
                <span className="card-sub">1번 영상 기준</span>
              </div>
              <div style={{ borderRadius: 8, overflow: 'hidden', background: '#050608' }}>
                <video
                  key={`${progressTrackingUrl}-${progress?.updatedAt ?? progress?.percent ?? 0}`}
                  src={progressTrackingUrl}
                  controls
                  muted
                  playsInline
                  style={{ display: 'block', width: '100%', maxHeight: 420, objectFit: 'contain' }}
                />
              </div>
            </div>
          )}
        </>
      )}
      {phase === 'result' && result && <DensityResultView data={result} onReset={reset} />}
    </div>
  );
}
