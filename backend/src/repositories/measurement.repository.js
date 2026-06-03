import { randomUUID } from 'node:crypto';
import { pool } from '../config/database.js';
import { mapMeasurement } from '../utils/mapper.js';

export const measurementRepository = {
  async findByBoxId(boxId, client = pool) {
    const result = await client.query(
      `SELECT * FROM measurements
       WHERE culture_box_id = $1
       ORDER BY measured_at ASC, created_at ASC`,
      [boxId]
    );
    return result.rows.map(mapMeasurement);
  },


  async findLatestByBoxIdAndType(boxId, type, client = pool) {
    const result = await client.query(
      `SELECT * FROM measurements
       WHERE culture_box_id = $1 AND type = $2
       ORDER BY measured_at DESC, created_at DESC
       LIMIT 1`,
      [boxId, type]
    );
    return result.rows[0] ? mapMeasurement(result.rows[0]) : null;
  },

  async create(input, client = pool) {
    const id = randomUUID();
    const result = await client.query(
      `INSERT INTO measurements (
         id, culture_box_id, analysis_job_id, type, measured_at,
         count_value, density_per_cm2, density_per_liter, vitality_score, active_ratio, result_summary
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        input.boxId,
        input.analysisJobId || null,
        input.type,
        input.measuredAt,
        input.countValue ?? null,
        input.densityPerCm2 ?? null,
        input.densityPerLiter ?? null,
        input.vitalityScore ?? null,
        input.activeRatio ?? null,
        input.resultJson || {},
      ]
    );
    return mapMeasurement(result.rows[0]);
  },

  async createDensityResult(input, client = pool) {
    const result = await client.query(
      `INSERT INTO density_results (
         id, measurement_id, measured_area_cm2, peak_count,
         average_count, density_per_cm2, best_frame_count, estimated_count_per_ml,
         density_per_liter, count_multiplier, video_duration_seconds,
         selected_frame_index, selected_frame_quality, density_grade
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        randomUUID(),
        input.measurementId,
        input.measuredAreaCm2 ?? null,
        input.peakCount ?? null,
        input.averageCount ?? null,
        input.densityPerCm2 ?? null,
        input.bestFrameCount ?? null,
        input.estimatedCountPerMl ?? null,
        input.densityPerLiter ?? null,
        input.countMultiplier ?? null,
        input.videoDurationSeconds ?? null,
        input.selectedFrameIndex ?? null,
        input.selectedFrameQuality || null,
        input.densityGrade || null,
      ]
    );
    return result.rows[0];
  },

  async createDensityFrameCounts(measurementId, frameCounts, client = pool) {
    if (!frameCounts?.length) return [];

    const rows = [];
    for (const frame of frameCounts) {
      const result = await client.query(
        `INSERT INTO density_frame_counts (id, measurement_id, frame_index, count_value, quality)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          randomUUID(),
          measurementId,
          frame.frameIndex ?? frame.frame_index ?? 0,
          frame.countValue ?? frame.count_value ?? 0,
          frame.quality || null,
        ]
      );
      rows.push(result.rows[0]);
    }
    return rows;
  },

  async createVitalityResult(input, client = pool) {
    const result = await client.query(
      `INSERT INTO vitality_results (
         id, measurement_id, vitality_score, active_ratio, average_speed_mm_per_sec
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        randomUUID(),
        input.measurementId,
        input.vitalityScore,
        input.activeRatio ?? null,
        input.averageSpeedMmPerSec ?? null,
      ]
    );
    return result.rows[0];
  },

  async createDetectionBoxes(measurementId, boxes, client = pool) {
    if (!boxes?.length) return [];

    const rows = [];
    for (const box of boxes) {
      const result = await client.query(
        `INSERT INTO detection_boxes (id, measurement_id, class_name, confidence, x, y, width, height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          randomUUID(),
          measurementId,
          box.className || box.cls || 'predator',
          box.confidence ?? box.conf ?? 0,
          box.x ?? 0,
          box.y ?? 0,
          box.width ?? box.w ?? 0,
          box.height ?? box.h ?? 0,
        ]
      );
      rows.push(result.rows[0]);
    }
    return rows;
  },
};
