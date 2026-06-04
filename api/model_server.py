from __future__ import annotations

import os
from queue import Queue
from threading import Lock, Thread
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

import cv2
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO

from .tracking_service import TrackingService
from .vitality_service import VitalityService


ROOT_DIR = Path(__file__).resolve().parents[1]
MODEL_PATH = Path(os.getenv("CHECKMITE_MODEL_PATH", ROOT_DIR / "model" / "best.pt"))
VITALITY_MODEL_PATH = Path(os.getenv("CHECKMITE_VITALITY_MODEL_PATH", ROOT_DIR / "model" / "vitality" / "best1.onnx"))
MODEL_PART_GLOB = "best.pt.part-*"
DEFAULT_CONF = float(os.getenv("CHECKMITE_CONF", "0.5"))
DEFAULT_IMGSZ = int(os.getenv("CHECKMITE_IMGSZ", "640"))
DEFAULT_TILE_SIZE = int(os.getenv("CHECKMITE_TILE_SIZE", "640"))
DEFAULT_TILE_OVERLAP = float(os.getenv("CHECKMITE_TILE_OVERLAP", "0.5"))
DEFAULT_NMS_IOU = float(os.getenv("CHECKMITE_NMS_IOU", "0.3"))
DEFAULT_VITALITY_TARGET_CLASS = os.getenv("CHECKMITE_VITALITY_TARGET_CLASS", "predator")
DEFAULT_VITALITY_IMGSZ = int(os.getenv("CHECKMITE_VITALITY_IMGSZ", "1280"))
DEFAULT_VITALITY_PX_PER_MM = float(os.getenv("CHECKMITE_VITALITY_PX_PER_MM", "1500"))
DEFAULT_VITALITY_REFERENCE_SPEED_MM_SEC = float(os.getenv("CHECKMITE_VITALITY_REFERENCE_SPEED_MM_SEC", "0.025"))
DEFAULT_VITALITY_MIN_TRACK_FRAMES = int(os.getenv("CHECKMITE_VITALITY_MIN_TRACK_FRAMES", "3"))
DEFAULT_VITALITY_MOTION_THRESHOLD_PX = float(os.getenv("CHECKMITE_VITALITY_MOTION_THRESHOLD_PX", "2.0"))
DEFAULT_VITALITY_MAX_FRAMES = int(os.getenv("CHECKMITE_VITALITY_MAX_FRAMES", "80"))
DEFAULT_VITALITY_NORMAL_SPEED_RATIO = float(os.getenv("CHECKMITE_VITALITY_NORMAL_SPEED_RATIO", "3.0"))
DEFAULT_VITALITY_NORMAL_SPEED_SCORE = float(os.getenv("CHECKMITE_VITALITY_NORMAL_SPEED_SCORE", "0.60"))
DEFAULT_VITALITY_FAST_SPEED_RATIO = float(os.getenv("CHECKMITE_VITALITY_FAST_SPEED_RATIO", "6.0"))
DEFAULT_VITALITY_FAST_SPEED_SCORE = float(os.getenv("CHECKMITE_VITALITY_FAST_SPEED_SCORE", "0.92"))
DEFAULT_DENSITY_TARGET_CLASS = os.getenv("CHECKMITE_DENSITY_TARGET_CLASS", "predator")
DEFAULT_DENSITY_FRAME_INTERVAL_SECONDS = float(os.getenv("CHECKMITE_DENSITY_FRAME_INTERVAL_SECONDS", "1"))
DEFAULT_DENSITY_COUNT_MULTIPLIER = float(os.getenv("CHECKMITE_DENSITY_COUNT_MULTIPLIER", "10"))
DEFAULT_DENSITY_MIN_VIDEO_SECONDS = float(os.getenv("CHECKMITE_DENSITY_MIN_VIDEO_SECONDS", "10"))
DEFAULT_ANALYSIS_WINDOW_SECONDS = float(os.getenv("CHECKMITE_ANALYSIS_WINDOW_SECONDS", "10"))
DEFAULT_DENSITY_MAX_FRAMES = int(os.getenv("CHECKMITE_DENSITY_MAX_FRAMES", "0"))
DEFAULT_DENSITY_MIN_SHARPNESS = float(os.getenv("CHECKMITE_DENSITY_MIN_SHARPNESS", "50"))
DEFAULT_DEVICE = os.getenv("CHECKMITE_DEVICE", "0").strip() or None
DEFAULT_DENSITY_MIN_BRIGHTNESS = float(os.getenv("CHECKMITE_DENSITY_MIN_BRIGHTNESS", "40"))
DEFAULT_DENSITY_MAX_BRIGHTNESS = float(os.getenv("CHECKMITE_DENSITY_MAX_BRIGHTNESS", "220"))
CLASS_NAMES = {
    0: "predator",
    1: "prey",
}

app = FastAPI(title="Checkmite Model API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CHECKMITE_CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

_model: YOLO | None = None
_vitality_model: YOLO | None = None
_inference_lock = Lock()


class VitalityRequest(BaseModel):
    filePath: str
    mimeType: str | None = None
    targetClass: str | None = None
    maxFrames: int | None = None
    renderTrackingVideo: bool | None = None
    trackingVideoPath: str | None = None


class DensityRequest(BaseModel):
    filePath: str
    mimeType: str | None = None
    targetClass: str | None = None
    frameSampleIntervalSeconds: float | None = None
    countMultiplier: float | None = None
    maxFrames: int | None = None


def restore_model_from_parts() -> None:
    if MODEL_PATH.exists():
        return

    part_dir = MODEL_PATH.parent
    parts = sorted(part_dir.glob(MODEL_PART_GLOB))
    if not parts:
        return

    tmp_path = MODEL_PATH.with_suffix(".pt.tmp")
    with tmp_path.open("wb") as out:
        for part in parts:
            with part.open("rb") as src:
                out.write(src.read())
    tmp_path.replace(MODEL_PATH)


def get_model() -> YOLO:
    global _model
    if _model is None:
        restore_model_from_parts()
        if not MODEL_PATH.exists():
            raise HTTPException(status_code=500, detail=f"Model file not found: {MODEL_PATH}")
        _model = YOLO(str(MODEL_PATH))
    return _model


def get_vitality_model() -> YOLO:
    global _vitality_model
    if _vitality_model is None:
        if VITALITY_MODEL_PATH.exists():
            # Temporary deployment note: ONNX Runtime GPU dependencies are
            # provided by the Docker runtime image and LD_LIBRARY_PATH.
            _vitality_model = YOLO(str(VITALITY_MODEL_PATH), task="detect")
        else:
            _vitality_model = get_model()
    return _vitality_model


def box_to_dict(box: Any, index: int) -> dict[str, Any]:
    cls_id = int(box.cls[0])
    conf = float(box.conf[0])
    x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
    return {
        "id": index,
        "class_id": cls_id,
        "class_name": CLASS_NAMES.get(cls_id, str(cls_id)),
        "confidence": conf,
        "box": {
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "width": x2 - x1,
            "height": y2 - y1,
        },
    }


def detection_to_dict(
    *,
    index: int,
    cls_id: int,
    conf: float,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
) -> dict[str, Any]:
    return {
        "id": index,
        "class_id": cls_id,
        "class_name": CLASS_NAMES.get(cls_id, str(cls_id)),
        "confidence": conf,
        "box": {
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "width": x2 - x1,
            "height": y2 - y1,
        },
    }


def box_to_tracking_detection(box: Any) -> dict[str, Any]:
    cls_id = int(box.cls[0])
    conf = float(box.conf[0])
    x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
    return {
        "bbox": [x1, y1, x2, y2],
        "center": [(x1 + x2) / 2.0, (y1 + y2) / 2.0],
        "score": conf,
        "class_name": CLASS_NAMES.get(cls_id, str(cls_id)),
    }


def predict_frame_detections(
    *,
    model: YOLO,
    frame: Any,
    conf: float,
    imgsz: int,
    device: str | int | None = None,
) -> list[dict[str, Any]]:
    predict_kwargs = {"conf": conf, "imgsz": imgsz, "verbose": False}
    if device is not None:
        predict_kwargs["device"] = device
    result = model.predict(frame, **predict_kwargs)[0]
    if result.boxes is None:
        return []
    return [box_to_tracking_detection(box) for box in result.boxes]


def frame_quality(frame: Any) -> dict[str, Any]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(gray.mean())
    brightness_ok = DEFAULT_DENSITY_MIN_BRIGHTNESS <= brightness <= DEFAULT_DENSITY_MAX_BRIGHTNESS
    sharpness_ok = sharpness >= DEFAULT_DENSITY_MIN_SHARPNESS
    if brightness < DEFAULT_DENSITY_MIN_BRIGHTNESS:
        brightness_score = brightness / DEFAULT_DENSITY_MIN_BRIGHTNESS
    elif brightness > DEFAULT_DENSITY_MAX_BRIGHTNESS:
        brightness_score = max(0.0, (255.0 - brightness) / (255.0 - DEFAULT_DENSITY_MAX_BRIGHTNESS))
    else:
        brightness_score = 1.0
    sharpness_score = min(sharpness / DEFAULT_DENSITY_MIN_SHARPNESS, 1.0)
    quality_score = max(0.0, min(0.65 * sharpness_score + 0.35 * brightness_score, 1.0))
    return {
        "sharpness": round(sharpness, 3),
        "brightness": round(brightness, 3),
        "quality_score": round(quality_score, 4),
        "passes_quality": sharpness_ok and brightness_ok,
    }


def density_grade(estimated_count_per_ml: int) -> str:
    return "marketable" if estimated_count_per_ml >= 10 else "low"


def analyze_density_video(
    *,
    model: YOLO | None,
    video_path: Path,
    conf: float,
    imgsz: int,
    target_class: str,
    frame_interval_seconds: float,
    count_multiplier: float,
    max_frames: int,
) -> dict[str, Any]:
    if frame_interval_seconds <= 0:
        raise HTTPException(status_code=400, detail="frameSampleIntervalSeconds must be greater than 0")
    if count_multiplier <= 0:
        raise HTTPException(status_code=400, detail="countMultiplier must be greater than 0")

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise HTTPException(status_code=400, detail="Could not open video")

    fps = capture.get(cv2.CAP_PROP_FPS) or 10.0
    frame_total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_seconds = frame_total / fps if frame_total > 0 and fps > 0 else 0.0
    if duration_seconds < DEFAULT_DENSITY_MIN_VIDEO_SECONDS:
        capture.release()
        raise HTTPException(
            status_code=400,
            detail=f"Density video must be at least {DEFAULT_DENSITY_MIN_VIDEO_SECONDS:g} seconds",
        )

    sample_stride = max(1, int(round(fps * frame_interval_seconds)))
    analysis_frame_total = frame_total
    if DEFAULT_ANALYSIS_WINDOW_SECONDS > 0:
        analysis_frame_total = min(frame_total, max(1, int(round(fps * DEFAULT_ANALYSIS_WINDOW_SECONDS))))
    frame_indices = list(range(0, analysis_frame_total, sample_stride))
    if max_frames:
        frame_indices = frame_indices[:max_frames]

    model = model or get_model()
    frame_rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    try:
        for frame_index in frame_indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ok, frame = capture.read()
            if not ok:
                warnings.append(f"Could not read frame {frame_index}")
                continue

            detections = predict_frame_detections(
                model=model,
                frame=frame,
                conf=conf,
                imgsz=imgsz,
                device=DEFAULT_DEVICE,
            )
            target_detections = [
                detection for detection in detections
                if detection["class_name"] == target_class
            ]
            quality = frame_quality(frame)
            frame_rows.append({
                "frameIndex": frame_index,
                "timestampSeconds": round(frame_index / fps, 3),
                "countValue": len(target_detections),
                "quality": quality,
            })
    finally:
        capture.release()

    if not frame_rows:
        raise HTTPException(status_code=400, detail="No frames could be sampled from video")

    quality_rows = [row for row in frame_rows if row["quality"]["passes_quality"]]
    if not quality_rows:
        warnings.append("No sampled frame passed quality filters; selected the best available frame")
        quality_rows = frame_rows

    selected = max(
        quality_rows,
        key=lambda row: (row["countValue"], row["quality"]["quality_score"], -row["frameIndex"]),
    )
    best_frame_count = int(selected["countValue"])
    average_frame_count = sum(row["countValue"] for row in frame_rows) / len(frame_rows)
    estimated_count_per_ml = int(round(average_frame_count * count_multiplier))
    density_per_liter = estimated_count_per_ml * 1000

    return {
        "countValue": estimated_count_per_ml,
        "bestFrameCount": best_frame_count,
        "estimatedCountPerMl": estimated_count_per_ml,
        "densityPerLiter": density_per_liter,
        "averageFrameCount": round(average_frame_count, 3),
        "sampledFrames": len(frame_rows),
        "videoDurationSeconds": round(duration_seconds, 3),
        "analysisWindowSeconds": round(min(duration_seconds, DEFAULT_ANALYSIS_WINDOW_SECONDS), 3)
        if DEFAULT_ANALYSIS_WINDOW_SECONDS > 0 else round(duration_seconds, 3),
        "fps": round(fps, 3),
        "targetClass": target_class,
        "countMultiplier": count_multiplier,
        "selectedFrameIndex": selected["frameIndex"],
        "selectedFrameTimestampSeconds": selected["timestampSeconds"],
        "selectedFrameQuality": selected["quality"],
        "densityGrade": density_grade(estimated_count_per_ml),
        "warnings": warnings,
        "frameCounts": frame_rows,
    }


class AsyncTrackingVideoWriter:
    def __init__(self, output_path: Path, fps: float, frame_size: tuple[int, int]):
        self.output_path = output_path
        self.queue: Queue[Any] = Queue()
        fourcc = cv2.VideoWriter_fourcc(*"VP80")
        self.writer = cv2.VideoWriter(str(output_path), fourcc, fps, frame_size)
        if not self.writer.isOpened():
            raise HTTPException(status_code=500, detail="Could not create tracking video")
        self.thread = Thread(target=self._run, name="checkmite-tracking-writer", daemon=True)
        self.thread.start()

    def submit(self, frame: Any) -> None:
        self.queue.put(frame.copy())

    def close(self, wait: bool = False) -> None:
        self.queue.put(None)
        if wait:
            self.thread.join()

    def _run(self) -> None:
        try:
            while True:
                frame = self.queue.get()
                if frame is None:
                    break
                self.writer.write(frame)
        finally:
            self.writer.release()


def analyze_vitality_video(
    *,
    model: YOLO,
    video_path: Path,
    conf: float,
    imgsz: int,
    target_class: str,
    max_frames: int,
    render_tracking_video: bool = False,
    tracking_video_path: Path | None = None,
) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise HTTPException(status_code=400, detail="Could not open video")

    fps = capture.get(cv2.CAP_PROP_FPS) or 10.0
    frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    analysis_frame_limit = 0
    if DEFAULT_ANALYSIS_WINDOW_SECONDS > 0:
        analysis_frame_limit = max(1, int(round(fps * DEFAULT_ANALYSIS_WINDOW_SECONDS)))
    if max_frames:
        analysis_frame_limit = min(analysis_frame_limit, max_frames) if analysis_frame_limit else max_frames
    writer: AsyncTrackingVideoWriter | None = None
    if render_tracking_video:
        if not tracking_video_path:
            tracking_video_path = video_path.with_name(f"{video_path.stem}-tracking.webm")
        tracking_video_path.parent.mkdir(parents=True, exist_ok=True)
        writer = AsyncTrackingVideoWriter(tracking_video_path, fps, (frame_width, frame_height))

    tracker = TrackingService(motion_threshold_px=DEFAULT_VITALITY_MOTION_THRESHOLD_PX)
    vitality = VitalityService(
        min_track_frames=DEFAULT_VITALITY_MIN_TRACK_FRAMES,
        motion_threshold_px=DEFAULT_VITALITY_MOTION_THRESHOLD_PX,
        px_per_mm=DEFAULT_VITALITY_PX_PER_MM,
        reference_speed_mm_sec=DEFAULT_VITALITY_REFERENCE_SPEED_MM_SEC,
        target_class_name=target_class,
        normal_speed_ratio=DEFAULT_VITALITY_NORMAL_SPEED_RATIO,
        normal_speed_score=DEFAULT_VITALITY_NORMAL_SPEED_SCORE,
        fast_speed_ratio=DEFAULT_VITALITY_FAST_SPEED_RATIO,
        fast_speed_score=DEFAULT_VITALITY_FAST_SPEED_SCORE,
    )

    frame_idx = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break

            detections = predict_frame_detections(
                model=model,
                frame=frame,
                conf=conf,
                imgsz=imgsz,
                device=DEFAULT_DEVICE,
            )
            detections = [
                detection for detection in detections
                if detection["class_name"] == target_class
            ]
            tracked_detections = tracker.update(detections, frame_idx)
            if writer is not None:
                for detection in tracked_detections:
                    x1, y1, x2, y2 = [int(v) for v in detection["bbox"]]
                    track_id = detection.get("track_id", 0)
                    distance = detection.get("distance_from_previous_px", 0.0)
                    color = (0, 0, 255)
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    cv2.putText(
                        frame,
                        f"ID {track_id}",
                        (x1, max(18, y1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.55,
                        color,
                        2,
                        cv2.LINE_AA,
                    )
                for track in tracker.tracks.values():
                    points = [tuple(int(v) for v in item["center"]) for item in track["trajectory"][-30:]]
                    for point_a, point_b in zip(points, points[1:]):
                        cv2.line(frame, point_a, point_b, (255, 190, 70), 2)
                writer.submit(frame)
            frame_idx += 1

            if analysis_frame_limit and frame_idx >= analysis_frame_limit:
                break
    finally:
        capture.release()
        if writer is not None:
            writer.close(wait=True)

    summary_rows, aggregate = vitality.summarize(tracker.tracks, frame_idx, fps)
    result = {
        "vitalityScore": aggregate["vitality_score"],
        "score": aggregate["vitality_score"],
        "activeRatio": aggregate["moving_ratio"],
        "averageSpeedMmPerSec": aggregate["mean_speed_mm_sec"],
        "averageSpeedRatio": aggregate["mean_speed_ratio"],
        "activityIndex": aggregate["activity_index"],
        "speedScore": aggregate["speed_score"],
        "observationStability": aggregate["observation_stability"],
        "estimatedLiveRatio": aggregate["estimated_live_ratio"],
        "confirmedTracks": aggregate["confirmed_tracks"],
        "movingTracks": aggregate["moving_tracks"],
        "targetClass": aggregate["target_class_name"],
        "frameCount": aggregate["frame_count"],
        "fps": aggregate["fps"],
        "observedSeconds": aggregate["observed_seconds"],
        "trend": [aggregate["vitality_score"]],
        "tracks": summary_rows,
        "summary": aggregate,
    }
    if render_tracking_video and tracking_video_path:
        result["trackingVideoPath"] = str(tracking_video_path)
        result["trackingVideoStatus"] = "processing"
    return result


def axis_starts(length: int, tile_size: int, overlap: float) -> list[int]:
    if length <= tile_size:
        return [0]

    stride = max(1, int(tile_size * (1 - overlap)))
    starts = list(range(0, length - tile_size + 1, stride))
    last = length - tile_size
    if starts[-1] != last:
        starts.append(last)
    return starts


def box_iou(a: dict[str, Any], b: dict[str, Any]) -> float:
    ab = a["box"]
    bb = b["box"]
    x1 = max(ab["x1"], bb["x1"])
    y1 = max(ab["y1"], bb["y1"])
    x2 = min(ab["x2"], bb["x2"])
    y2 = min(ab["y2"], bb["y2"])
    inter_w = max(0.0, x2 - x1)
    inter_h = max(0.0, y2 - y1)
    inter = inter_w * inter_h
    if inter <= 0:
        return 0.0

    area_a = max(0.0, ab["width"]) * max(0.0, ab["height"])
    area_b = max(0.0, bb["width"]) * max(0.0, bb["height"])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def class_aware_nms(detections: list[dict[str, Any]], iou_threshold: float) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    for det in sorted(detections, key=lambda item: item["confidence"], reverse=True):
        duplicate = any(
            det["class_id"] == kept_det["class_id"] and box_iou(det, kept_det) > iou_threshold
            for kept_det in kept
        )
        if not duplicate:
            kept.append(det)

    for index, det in enumerate(kept, start=1):
        det["id"] = index
    return kept


def predict_tiled(
    *,
    model: YOLO,
    image_path: Path,
    conf: float,
    imgsz: int,
    tile_size: int,
    overlap: float,
    nms_iou: float,
    device: str | int | None = None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    image = cv2.imread(str(image_path))
    if image is None:
        raise HTTPException(status_code=400, detail="Could not decode image")

    height, width = image.shape[:2]
    xs = axis_starts(width, tile_size, overlap)
    ys = axis_starts(height, tile_size, overlap)
    detections: list[dict[str, Any]] = []

    for y in ys:
        for x in xs:
            tile = image[y : min(y + tile_size, height), x : min(x + tile_size, width)]
            result = model.predict(tile, conf=conf, imgsz=imgsz, iou=nms_iou, verbose=False, device=device)[0]
            for box in result.boxes:
                cls_id = int(box.cls[0])
                box_conf = float(box.conf[0])
                x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
                detections.append(
                    detection_to_dict(
                        index=len(detections) + 1,
                        cls_id=cls_id,
                        conf=box_conf,
                        x1=max(0.0, min(width, x1 + x)),
                        y1=max(0.0, min(height, y1 + y)),
                        x2=max(0.0, min(width, x2 + x)),
                        y2=max(0.0, min(height, y2 + y)),
                    )
                )

    return class_aware_nms(detections, nms_iou), {"width": width, "height": height, "tiles": len(xs) * len(ys)}


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model_path": str(MODEL_PATH),
        "model_exists": MODEL_PATH.exists(),
        "vitality_model_path": str(VITALITY_MODEL_PATH),
        "vitality_model_exists": VITALITY_MODEL_PATH.exists(),
    }


@app.get("/model/info")
def model_info() -> dict[str, Any]:
    return {
        "name": "checkmite-mvp1v11-yolov8m",
        "task": "object-detection",
        "framework": "ultralytics-yolov8",
        "weights": str(MODEL_PATH.relative_to(ROOT_DIR)),
        "vitality_weights": str(VITALITY_MODEL_PATH.relative_to(ROOT_DIR)) if VITALITY_MODEL_PATH.exists() else None,
        "weight_parts": [str(p.relative_to(ROOT_DIR)) for p in sorted(MODEL_PATH.parent.glob(MODEL_PART_GLOB))],
        "input_size": DEFAULT_IMGSZ,
        "device": DEFAULT_DEVICE,
        "inference": {
            "mode": "sahi-style-tiled",
            "tile_size": DEFAULT_TILE_SIZE,
            "tile_overlap_ratio": DEFAULT_TILE_OVERLAP,
            "confidence": DEFAULT_CONF,
            "nms_iou_threshold": DEFAULT_NMS_IOU,
        },
        "density": {
            "target_class": DEFAULT_DENSITY_TARGET_CLASS,
            "frame_interval_seconds": DEFAULT_DENSITY_FRAME_INTERVAL_SECONDS,
            "count_multiplier": DEFAULT_DENSITY_COUNT_MULTIPLIER,
            "min_video_seconds": DEFAULT_DENSITY_MIN_VIDEO_SECONDS,
            "analysis_window_seconds": DEFAULT_ANALYSIS_WINDOW_SECONDS,
            "min_sharpness": DEFAULT_DENSITY_MIN_SHARPNESS,
            "brightness_range": [DEFAULT_DENSITY_MIN_BRIGHTNESS, DEFAULT_DENSITY_MAX_BRIGHTNESS],
        },
        "vitality": {
            "mode": "full-frame-non-tiled",
            "weights": str(VITALITY_MODEL_PATH.relative_to(ROOT_DIR)) if VITALITY_MODEL_PATH.exists() else str(MODEL_PATH.relative_to(ROOT_DIR)),
            "target_class": DEFAULT_VITALITY_TARGET_CLASS,
            "image_size": DEFAULT_VITALITY_IMGSZ,
            "max_frames": DEFAULT_VITALITY_MAX_FRAMES,
            "analysis_window_seconds": DEFAULT_ANALYSIS_WINDOW_SECONDS,
            "prey_reference_speed_mm_sec": DEFAULT_VITALITY_REFERENCE_SPEED_MM_SEC,
            "normal_speed_ratio": DEFAULT_VITALITY_NORMAL_SPEED_RATIO,
            "normal_speed_score": DEFAULT_VITALITY_NORMAL_SPEED_SCORE,
            "fast_speed_ratio": DEFAULT_VITALITY_FAST_SPEED_RATIO,
            "fast_speed_score": DEFAULT_VITALITY_FAST_SPEED_SCORE,
            "confidence": DEFAULT_CONF,
        },
        "classes": CLASS_NAMES,
        "training_summary": {
            "base_model": "yolov8m.pt",
            "image_size": 640,
            "tile_size": 640,
            "tile_overlap_ratio": 0.25,
            "epochs": 300,
            "batch": 16,
            "augmentation": ["degrees=45", "flipud=0.5", "fliplr=0.5", "mosaic=1.0"],
        },
    }


@app.post("/predict/image")
async def predict_image(
    file: UploadFile = File(...),
    conf: float = DEFAULT_CONF,
    imgsz: int = DEFAULT_IMGSZ,
    tile_size: int = DEFAULT_TILE_SIZE,
    overlap: float = DEFAULT_TILE_OVERLAP,
    nms: float = DEFAULT_NMS_IOU,
) -> dict[str, Any]:
    allowed_content_types = {"application/octet-stream", "binary/octet-stream"}
    if (
        file.content_type
        and not file.content_type.startswith("image/")
        and file.content_type not in allowed_content_types
    ):
        raise HTTPException(status_code=400, detail="Only image uploads are supported")

    suffix = Path(file.filename or "upload.jpg").suffix or ".jpg"
    with NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)

    try:
        if tile_size <= 0:
            raise HTTPException(status_code=400, detail="tile_size must be greater than 0")
        if not 0 <= overlap < 1:
            raise HTTPException(status_code=400, detail="overlap must be between 0 and 1")
        if not 0 <= nms <= 1:
            raise HTTPException(status_code=400, detail="nms must be between 0 and 1")

        with _inference_lock:
            model = get_model()
            detections, image_info = predict_tiled(
                model=model,
                image_path=tmp_path,
                conf=conf,
                imgsz=imgsz,
                tile_size=tile_size,
                overlap=overlap,
                nms_iou=nms,
                device=DEFAULT_DEVICE,
            )
        counts = {name: 0 for name in CLASS_NAMES.values()}
        for det in detections:
            counts[det["class_name"]] = counts.get(det["class_name"], 0) + 1

        return {
            "filename": file.filename,
            "image": {"width": image_info["width"], "height": image_info["height"]},
            "settings": {
                "confidence": conf,
                "image_size": imgsz,
                "mode": "sahi-style-tiled",
                "tile_size": tile_size,
                "overlap": overlap,
                "nms_threshold": nms,
                "tiles_processed": image_info["tiles"],
            },
            "counts": counts,
            "total": len(detections),
            "detections": detections,
        }
    finally:
        tmp_path.unlink(missing_ok=True)


@app.post("/infer/vitality")
def infer_vitality(payload: VitalityRequest) -> dict[str, Any]:
    video_path = Path(payload.filePath)
    if not video_path.exists():
        raise HTTPException(status_code=400, detail=f"Video file not found: {video_path}")

    with _inference_lock:
        model = get_vitality_model()
        return analyze_vitality_video(
            model=model,
            video_path=video_path,
            conf=DEFAULT_CONF,
            imgsz=DEFAULT_VITALITY_IMGSZ,
            target_class=payload.targetClass or DEFAULT_VITALITY_TARGET_CLASS,
            max_frames=payload.maxFrames or DEFAULT_VITALITY_MAX_FRAMES,
            render_tracking_video=bool(payload.renderTrackingVideo),
            tracking_video_path=Path(payload.trackingVideoPath) if payload.trackingVideoPath else None,
        )


@app.post("/infer/density")
def infer_density(payload: DensityRequest) -> dict[str, Any]:
    video_path = Path(payload.filePath)
    if not video_path.exists():
        raise HTTPException(status_code=400, detail=f"Video file not found: {video_path}")

    with _inference_lock:
        return analyze_density_video(
            model=None,
            video_path=video_path,
            conf=DEFAULT_CONF,
            imgsz=DEFAULT_IMGSZ,
            target_class=payload.targetClass or DEFAULT_DENSITY_TARGET_CLASS,
            frame_interval_seconds=payload.frameSampleIntervalSeconds or DEFAULT_DENSITY_FRAME_INTERVAL_SECONDS,
            count_multiplier=payload.countMultiplier or DEFAULT_DENSITY_COUNT_MULTIPLIER,
            max_frames=payload.maxFrames or DEFAULT_DENSITY_MAX_FRAMES,
        )
