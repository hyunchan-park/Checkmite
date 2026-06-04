import fs from 'node:fs';
import path from 'node:path';
import { withTransaction } from '../config/database.js';
import { env } from '../config/env.js';
import { analysisJobRepository } from '../repositories/analysis-job.repository.js';
import { cultureBoxRepository } from '../repositories/culture-box.repository.js';
import { measurementRepository } from '../repositories/measurement.repository.js';
import { uploadedFileRepository } from '../repositories/uploaded-file.repository.js';
import { HttpError, notFound } from '../utils/http-error.js';
import { analysisProgressService } from './analysis-progress.service.js';
import { modelRuntimeService } from './model-runtime.service.js';

const createUploadedFile = async (file, boxId, client) => {
  if (!file) return null;
  return uploadedFileRepository.create(
    {
      boxId,
      originalName: file.originalname,
      mimeType: file.mimetype,
      fileSize: file.size,
      storagePath: file.path,
    },
    client
  );
};

const numberOrZero = (value) => Number(value ?? 0);
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
const isShortDensityVideoError = (message) => message.includes("Density video must be at least");
const isUnreadableVideoError = (message) => message.includes("Could not open video");
const QUALITY_WARNING_TEXT = 'No sampled frame passed quality filters; selected the best available frame';
const vitalityNoticeForSpeedRatio = (ratio) => {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return null;
  const value = Number(ratio);
  if (value <= 2) {
    return {
      level: 'danger',
      label: '위험',
      message: `천적응애 평균속도가 먹이응애 기준 ${value.toFixed(2)}x입니다. 2x 이하이면 활력 저하 위험으로 즉시 확인이 필요합니다.`,
    };
  }
  if (value <= 3) {
    return {
      level: 'caution',
      label: '주의',
      message: `천적응애 평균속도가 먹이응애 기준 ${value.toFixed(2)}x입니다. 3x 이하이면 활력 저하 가능성을 관찰해야 합니다.`,
    };
  }
  return {
    level: 'normal',
    label: '정상 관찰',
    message: `천적응애 평균속도가 먹이응애 기준 ${value.toFixed(2)}x입니다.`,
  };
};

const toRepresentativeTrack = (sample, track) => ({
  sampleIndex: sample.sampleIndex,
  originalName: sample.originalName,
  trackId: track.track_id,
  framesSeen: track.frames_seen,
  firstFrameIndex: track.first_frame_idx,
  lastFrameIndex: track.last_frame_idx,
  totalDistancePx: track.total_distance_px,
  totalDistanceMm: track.total_distance_mm,
  meanSpeedPxPerSec: track.mean_speed_px_sec,
  meanSpeedMmPerSec: track.mean_speed_mm_sec,
  meanSpeedRatio: track.mean_speed_ratio,
  movingRatio: track.moving_ratio,
  vitalityScore: track.vitality_score,
  visibilityRatio: track.visibility_ratio,
  averageConfidence: track.avg_confidence,
  isLiveMotion: Boolean(track.is_live_motion),
});

const compareRepresentativeTracks = (a, b) => {
  const aValues = [
    a.isLiveMotion ? 1 : 0,
    numberOrZero(a.vitalityScore),
    numberOrZero(a.framesSeen),
    numberOrZero(a.totalDistancePx),
  ];
  const bValues = [
    b.isLiveMotion ? 1 : 0,
    numberOrZero(b.vitalityScore),
    numberOrZero(b.framesSeen),
    numberOrZero(b.totalDistancePx),
  ];

  for (let index = 0; index < aValues.length; index += 1) {
    if (aValues[index] !== bValues[index]) return bValues[index] - aValues[index];
  }
  return 0;
};

const selectRepresentativeTrack = (sampleResults) => {
  const tracks = sampleResults.flatMap((sample) =>
    (sample.vitality.tracks || []).map((track) => toRepresentativeTrack(sample, track))
  );
  return tracks.sort(compareRepresentativeTracks)[0] ?? null;
};

const trackingVideoOutputFor = (file) => {
  const baseName = path.parse(file.filename || path.basename(file.path)).name;
  const relativePath = path.join('tracking', `${baseName}-tracking.webm`);
  const outputPath = path.join(env.uploadDir, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  return {
    outputPath,
    url: `/uploads/${relativePath.split(path.sep).join('/')}`,
  };
};

export const analysisService = {
  async startDensity(input, files) {
    const box = await cultureBoxRepository.findById(input.boxId);
    if (!box || box.deletedAt) throw notFound('활성 사육박스를 찾을 수 없습니다.');

    const densityFiles = Array.isArray(files) ? files : [];
    if (densityFiles.length < 1) {
      throw new HttpError(400, '밀도 측정은 1개 이상의 1 mL 배지 영상이 필요합니다.');
    }

    const progress = analysisProgressService.create({ type: 'density', totalSamples: densityFiles.length });
    setImmediate(async () => {
      try {
        const result = await this.runDensity(input, densityFiles, { progressJobId: progress.id });
        analysisProgressService.complete(progress.id, result);
      } catch (error) {
        analysisProgressService.fail(progress.id, error);
      }
    });

    return progress;
  },

  getDensityProgress(jobId) {
    const progress = analysisProgressService.get(jobId);
    if (!progress) throw notFound('분석 작업을 찾을 수 없습니다.');
    return progress;
  },

  async runDensity(input, files, options = {}) {
    const box = await cultureBoxRepository.findById(input.boxId);
    if (!box || box.deletedAt) throw notFound('활성 사육박스를 찾을 수 없습니다.');

    const densityFiles = Array.isArray(files) ? files : [];
    if (densityFiles.length < 1) {
      throw new HttpError(400, '밀도 측정은 1개 이상의 1 mL 배지 영상이 필요합니다.');
    }

    const sampleResults = [];
    const totalOps = densityFiles.length * 2;
    let completedOps = 0;
    const updateProgress = (sampleIndex, phase, patch = {}) => {
      if (!options.progressJobId) return;
      const percent = Math.min(99, Math.round((completedOps / totalOps) * 100));
      analysisProgressService.update(options.progressJobId, {
        status: 'processing',
        percent,
        currentSample: sampleIndex,
        message: `${sampleIndex}/${densityFiles.length} ${phase}`,
      });
      analysisProgressService.updateSample(options.progressJobId, sampleIndex, patch);
    };

    for (let index = 0; index < densityFiles.length; index += 1) {
      const file = densityFiles[index];
      const sampleIndex = index + 1;
      updateProgress(sampleIndex, '밀도 분석 중', {
        status: 'density',
        originalName: file.originalname,
      });
      let densityResult;
      try {
        densityResult = await modelRuntimeService.inferDensity({
          cultureBoxId: input.boxId,
          filePath: file?.path,
          measuredAt: input.measuredAt,
          mimeType: file?.mimetype,
          sampleIndex,
        });
      } catch (error) {
        const message = errorMessage(error);
        if (isShortDensityVideoError(message) || isUnreadableVideoError(message)) {
          completedOps += 2;
          updateProgress(sampleIndex, isShortDensityVideoError(message) ? '10초 미만 제외' : '읽을 수 없는 영상 제외', {
            status: 'skipped',
            originalName: file.originalname,
            error: isShortDensityVideoError(message)
              ? '10초 미만 영상이라 분석에서 제외했습니다.'
              : '영상 파일을 열 수 없어 분석에서 제외했습니다.',
          });
          continue;
        }
        updateProgress(sampleIndex, '밀도 분석 실패', {
          status: 'failed',
          error: message,
        });
        throw new Error(`${sampleIndex}/${densityFiles.length} 밀도 분석 실패: ${message}`);
      }
      completedOps += 1;
      updateProgress(sampleIndex, '활력도 분석 중', {
        status: 'vitality',
        bestFrameCount: densityResult.bestFrameCount,
        estimatedCountPerMl: densityResult.estimatedCountPerMl,
      });
      const trackingVideo = sampleResults.length === 0 ? trackingVideoOutputFor(file) : null;
      if (trackingVideo) {
        updateProgress(sampleIndex, '트래킹 영상 생성 중');
      }
      let vitalityResult;
      try {
        vitalityResult = await modelRuntimeService.inferVitality({
          cultureBoxId: input.boxId,
          filePath: file?.path,
          mimeType: file?.mimetype,
          measuredAt: input.measuredAt,
          sampleIndex,
          renderTrackingVideo: Boolean(trackingVideo),
          trackingVideoPath: trackingVideo?.outputPath,
        });
      } catch (error) {
        updateProgress(sampleIndex, '활력도 분석 실패', {
          status: 'failed',
          error: errorMessage(error),
        });
        throw new Error(`${sampleIndex}/${densityFiles.length} 활력도 분석 실패: ${errorMessage(error)}`);
      }
      if (trackingVideo && vitalityResult.trackingVideoPath) {
        vitalityResult.trackingVideoUrl = trackingVideo.url;
      }
      completedOps += 1;
      updateProgress(sampleIndex, '샘플 완료', {
        status: 'completed',
        vitalityScore: Number(vitalityResult.vitalityScore ?? vitalityResult.score ?? 0),
        activeRatio: vitalityResult.activeRatio,
        confirmedTracks: vitalityResult.confirmedTracks,
        movingTracks: vitalityResult.movingTracks,
        trackingVideoUrl: vitalityResult.trackingVideoUrl,
      });
      sampleResults.push({
        sampleIndex,
        originalName: file.originalname,
        density: densityResult,
        vitality: vitalityResult,
      });
    }

    if (sampleResults.length < 1) {
      throw new Error('분석 가능한 10초 이상 영상이 없습니다. 10초 미만 영상은 자동 제외됩니다.');
    }

    const estimatedCounts = sampleResults.map((result) => Number(result.density.estimatedCountPerMl ?? result.density.countValue ?? 0));
    const bestFrameCounts = sampleResults.map((result) => Number(result.density.bestFrameCount ?? result.density.peakCount ?? 0));
    const estimatedCountPerMl = Math.round(
      estimatedCounts.reduce((sum, value) => sum + value, 0) / sampleResults.length
    );
    const bestFrameCount = Math.max(...bestFrameCounts);
    const representativeSample = sampleResults.reduce((best, item) => {
      const bestCount = Number(best.density.bestFrameCount ?? best.density.peakCount ?? 0);
      const itemCount = Number(item.density.bestFrameCount ?? item.density.peakCount ?? 0);
      return itemCount > bestCount ? item : best;
    }, sampleResults[0]);
    const densityPerLiter = estimatedCountPerMl * 1000;
    const averageFrameCount = sampleResults.reduce(
      (sum, result) => sum + Number(result.density.averageFrameCount ?? result.density.averageCount ?? 0),
      0
    ) / sampleResults.length;
    const totalSampledFrames = sampleResults.reduce((sum, result) => sum + Number(result.density.sampledFrames ?? 0), 0);
    const rawWarnings = sampleResults.flatMap((result) =>
      (result.density.warnings || []).map((warning) => ({
        sampleIndex: result.sampleIndex,
        originalName: result.originalName,
        warning,
      }))
    );
    const qualityWarningSamples = rawWarnings
      .filter((item) => item.warning.includes(QUALITY_WARNING_TEXT))
      .map((item) => ({ sampleIndex: item.sampleIndex, originalName: item.originalName }));
    const warnings = rawWarnings
      .filter((item) => !item.warning.includes(QUALITY_WARNING_TEXT))
      .map((item) => `${item.sampleIndex}번 영상 ${item.originalName ?? ''}: ${item.warning}`.trim());
    const qualityWarningSummary = qualityWarningSamples.length
      ? {
        count: qualityWarningSamples.length,
        sampleIndices: qualityWarningSamples.map((item) => item.sampleIndex),
        samples: qualityWarningSamples,
        message: `품질 기준을 통과한 프레임이 없는 영상 ${qualityWarningSamples.length}개는 최선 프레임으로 분석했습니다.`,
      }
      : null;
    const vitalityScores = sampleResults.map((result) => Number(result.vitality.vitalityScore ?? result.vitality.score ?? 0));
    const activeRatios = sampleResults
      .map((result) => result.vitality.activeRatio)
      .filter((value) => value !== undefined && value !== null)
      .map(Number);
    const averageSpeeds = sampleResults
      .map((result) => result.vitality.averageSpeedMmPerSec)
      .filter((value) => value !== undefined && value !== null)
      .map(Number);
    const averageSpeedRatios = sampleResults
      .map((result) => result.vitality.averageSpeedRatio)
      .filter((value) => value !== undefined && value !== null)
      .map(Number);
    const averageVitalityScore = vitalityScores.reduce((sum, value) => sum + value, 0) / sampleResults.length;
    const averageActiveRatio = activeRatios.length
      ? activeRatios.reduce((sum, value) => sum + value, 0) / activeRatios.length
      : null;
    const averageSpeedMmPerSec = averageSpeeds.length
      ? averageSpeeds.reduce((sum, value) => sum + value, 0) / averageSpeeds.length
      : null;
    const averageSpeedRatio = averageSpeedRatios.length
      ? averageSpeedRatios.reduce((sum, value) => sum + value, 0) / averageSpeedRatios.length
      : null;
    const confirmedTracks = sampleResults.reduce((sum, result) => sum + Number(result.vitality.confirmedTracks ?? 0), 0);
    const movingTracks = sampleResults.reduce((sum, result) => sum + Number(result.vitality.movingTracks ?? 0), 0);
    const representativeTrack = selectRepresentativeTrack(sampleResults.slice(0, 1));
    const trackingVideoUrl = sampleResults[0]?.vitality.trackingVideoUrl ?? null;
    const vitalityNotice = vitalityNoticeForSpeedRatio(averageSpeedRatio);
    const modelResult = {
      sampleCount: sampleResults.length,
      sampleResults,
      countValue: estimatedCountPerMl,
      bestFrameCount,
      estimatedCountPerMl,
      densityPerLiter,
      averageFrameCount,
      sampledFrames: totalSampledFrames,
      countMultiplier: sampleResults[0]?.density.countMultiplier,
      videoDurationSeconds: sampleResults.reduce(
        (sum, result) => sum + Number(result.density.videoDurationSeconds ?? 0),
        0
      ) / sampleResults.length,
      selectedFrameIndex: representativeSample?.density.selectedFrameIndex,
      selectedFrameTimestampSeconds: representativeSample?.density.selectedFrameTimestampSeconds,
      selectedFrameQuality: representativeSample?.density.selectedFrameQuality,
      densityGrade: estimatedCountPerMl >= 10 ? 'marketable' : 'low',
      warnings,
      qualityWarningSummary,
      frameCounts: sampleResults.flatMap((result) =>
        (result.density.frameCounts || []).map((frame) => ({
          ...frame,
          frameIndex: ((result.sampleIndex - 1) * 100000) + Number(frame.frameIndex ?? 0),
          sampleIndex: result.sampleIndex,
        }))
      ),
      vitalityScore: averageVitalityScore,
      activeRatio: averageActiveRatio,
      averageSpeedMmPerSec,
      averageSpeedRatio,
      vitalityNotice,
      confirmedTracks,
      movingTracks,
      representativeTrack,
      trackingVideoUrl,
      vitalityTrend: vitalityScores,
    };
    if (options.progressJobId) {
      analysisProgressService.update(options.progressJobId, {
        status: 'processing',
        percent: 99,
        message: '결과 저장 중',
      });
    }
    const countValue = Math.round(estimatedCountPerMl);
    const vitalityScore = Number(averageVitalityScore.toFixed(2));

    const previousDensity = await measurementRepository.findLatestByBoxIdAndType(input.boxId, 'density');
    const previousVitality = await measurementRepository.findLatestByBoxIdAndType(input.boxId, 'vitality');

    return withTransaction(async (client) => {
      const uploadedFiles = [];
      for (const file of densityFiles) {
        uploadedFiles.push(await createUploadedFile(file, input.boxId, client));
      }
      const job = await analysisJobRepository.create(
        { boxId: input.boxId, uploadedFileId: uploadedFiles[0]?.id, type: 'density' },
        client
      );
      await analysisJobRepository.markProcessing(job.id, client);

      const measurement = await measurementRepository.create(
        {
          boxId: input.boxId,
          analysisJobId: job.id,
          type: 'density',
          measuredAt: input.measuredAt,
          countValue,
          densityPerLiter,
          resultJson: modelResult,
        },
        client
      );

      await measurementRepository.createDensityResult(
        {
          measurementId: measurement.id,
          measuredAreaCm2: null,
          peakCount: bestFrameCount,
          averageCount: modelResult.averageFrameCount ?? modelResult.averageCount,
          densityPerCm2: null,
          bestFrameCount,
          estimatedCountPerMl,
          densityPerLiter,
          countMultiplier: modelResult.countMultiplier,
          videoDurationSeconds: modelResult.videoDurationSeconds,
          selectedFrameIndex: modelResult.selectedFrameIndex,
          selectedFrameQuality: modelResult.selectedFrameQuality,
          densityGrade: modelResult.densityGrade,
        },
        client
      );
      await measurementRepository.createDensityFrameCounts(
        measurement.id,
        modelResult.frameCounts || [],
        client
      );

      const vitalityJob = await analysisJobRepository.create(
        { boxId: input.boxId, uploadedFileId: uploadedFiles[0]?.id, type: 'vitality' },
        client
      );
      await analysisJobRepository.markProcessing(vitalityJob.id, client);

      const vitalityMeasurement = await measurementRepository.create(
        {
          boxId: input.boxId,
          analysisJobId: vitalityJob.id,
          type: 'vitality',
          measuredAt: input.measuredAt,
          vitalityScore,
          activeRatio: modelResult.activeRatio,
          resultJson: modelResult,
        },
        client
      );

      await measurementRepository.createVitalityResult(
        {
          measurementId: vitalityMeasurement.id,
          vitalityScore,
          activeRatio: modelResult.activeRatio,
          averageSpeedMmPerSec: modelResult.averageSpeedMmPerSec,
        },
        client
      );

      await analysisJobRepository.markCompleted(job.id, client);
      await analysisJobRepository.markCompleted(vitalityJob.id, client);

      return {
        measurementId: measurement.id,
        vitalityMeasurementId: vitalityMeasurement.id,
        boxId: input.boxId,
        type: 'density',
        measuredAt: measurement.measuredAt,
        density: {
          densityPerLiter,
          currentDensityPerLiter: densityPerLiter,
          estimatedCountPerMl,
          bestFrameCount,
          peakCount: bestFrameCount,
          averageFrameCount: modelResult.averageFrameCount,
          sampleCount: modelResult.sampleCount,
          sampledFrames: modelResult.sampledFrames,
          videoDurationSeconds: modelResult.videoDurationSeconds,
          analysisWindowSeconds: modelResult.sampleResults?.[0]?.density?.analysisWindowSeconds,
          selectedFrameIndex: modelResult.selectedFrameIndex,
          selectedFrameTimestampSeconds: modelResult.selectedFrameTimestampSeconds,
          selectedFrameQuality: modelResult.selectedFrameQuality,
          densityGrade: modelResult.densityGrade,
          warnings: modelResult.warnings || [],
          qualityWarningSummary: modelResult.qualityWarningSummary,
        },
        vitality: {
          score: vitalityScore,
          activeRatio: modelResult.activeRatio,
          averageSpeedMmPerSec: modelResult.averageSpeedMmPerSec,
          averageSpeedRatio: modelResult.averageSpeedRatio,
          notice: modelResult.vitalityNotice,
          confirmedTracks: modelResult.confirmedTracks,
          movingTracks: modelResult.movingTracks,
          representativeTrack: modelResult.representativeTrack,
          trackingVideoUrl: modelResult.trackingVideoUrl,
          trend: modelResult.vitalityTrend,
          sampleCount: modelResult.sampleCount,
        },
        previous: {
          density: previousDensity ? {
            measurementId: previousDensity.id,
            measuredAt: previousDensity.measuredAt,
            densityPerLiter: previousDensity.densityPerLiter,
            countValue: previousDensity.countValue,
          } : null,
          vitality: previousVitality ? {
            measurementId: previousVitality.id,
            measuredAt: previousVitality.measuredAt,
            score: previousVitality.vitalityScore,
            activeRatio: previousVitality.activeRatio,
          } : null,
        },
        samples: sampleResults.map((sample) => ({
          sampleIndex: sample.sampleIndex,
          originalName: sample.originalName,
          bestFrameCount: sample.density.bestFrameCount,
          estimatedCountPerMl: sample.density.estimatedCountPerMl,
          densityPerLiter: sample.density.densityPerLiter,
          averageFrameCount: sample.density.averageFrameCount,
          selectedFrameIndex: sample.density.selectedFrameIndex,
          vitalityScore: Number(sample.vitality.vitalityScore ?? sample.vitality.score ?? 0),
          activeRatio: sample.vitality.activeRatio,
          averageSpeedMmPerSec: sample.vitality.averageSpeedMmPerSec,
          averageSpeedRatio: sample.vitality.averageSpeedRatio,
          confirmedTracks: sample.vitality.confirmedTracks,
          movingTracks: sample.vitality.movingTracks,
        })),
        measurement,
        vitalityMeasurement,
      };
    });
  },

  async runVitality(input, file) {
    const box = await cultureBoxRepository.findById(input.boxId);
    if (!box || box.deletedAt) throw notFound('활성 사육박스를 찾을 수 없습니다.');

    const modelResult = await modelRuntimeService.inferVitality({
      cultureBoxId: input.boxId,
      filePath: file?.path,
      mimeType: file?.mimetype,
      measuredAt: input.measuredAt,
    });

    return withTransaction(async (client) => {
      const uploadedFile = await createUploadedFile(file, input.boxId, client);
      const job = await analysisJobRepository.create(
        { boxId: input.boxId, uploadedFileId: uploadedFile?.id, type: 'vitality' },
        client
      );
      await analysisJobRepository.markProcessing(job.id, client);

      const measurement = await measurementRepository.create(
        {
          boxId: input.boxId,
          analysisJobId: job.id,
          type: 'vitality',
          measuredAt: input.measuredAt,
          vitalityScore: Number(modelResult.vitalityScore ?? modelResult.score ?? 0),
          activeRatio: modelResult.activeRatio,
          resultJson: modelResult,
        },
        client
      );

      await measurementRepository.createVitalityResult(
        {
          measurementId: measurement.id,
          vitalityScore: measurement.vitalityScore,
          activeRatio: measurement.activeRatio,
          averageSpeedMmPerSec: modelResult.averageSpeedMmPerSec,
        },
        client
      );

      await analysisJobRepository.markCompleted(job.id, client);

      return {
        measurementId: measurement.id,
        boxId: input.boxId,
        type: 'vitality',
        measuredAt: measurement.measuredAt,
        vitality: {
          score: measurement.vitalityScore,
          activeRatio: measurement.activeRatio,
          trend: modelResult.trend || [],
        },
        measurement,
      };
    });
  },

  async runDetection(input, file) {
    const box = await cultureBoxRepository.findById(input.boxId);
    if (!box || box.deletedAt) throw notFound('활성 사육박스를 찾을 수 없습니다.');

    const modelResult = await modelRuntimeService.inferDetection({
      cultureBoxId: input.boxId,
      filePath: file?.path,
      measuredAt: input.measuredAt,
    });

    return withTransaction(async (client) => {
      const uploadedFile = await createUploadedFile(file, input.boxId, client);
      const job = await analysisJobRepository.create(
        { boxId: input.boxId, uploadedFileId: uploadedFile?.id, type: 'detection' },
        client
      );
      await analysisJobRepository.markProcessing(job.id, client);

      const measurement = await measurementRepository.create(
        {
          boxId: input.boxId,
          analysisJobId: job.id,
          type: 'detection',
          measuredAt: input.measuredAt,
          countValue: modelResult.countValue,
          resultJson: modelResult,
        },
        client
      );

      await measurementRepository.createDetectionBoxes(measurement.id, modelResult.boxes || [], client);
      await analysisJobRepository.markCompleted(job.id, client);

      return {
        measurementId: measurement.id,
        boxId: input.boxId,
        type: 'detection',
        measuredAt: measurement.measuredAt,
        detection: {
          countValue: measurement.countValue,
          boxes: modelResult.boxes || [],
        },
        measurement,
      };
    });
  },
};
