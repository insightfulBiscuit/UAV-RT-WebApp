from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pc_h30t_live_viewer as viewer  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def build_state(output_dir: Path, max_c: float) -> viewer.LiveState:
    state = viewer.LiveState(output_dir=viewer.ensure_dir(output_dir))
    state.temperature_video_offset_ms = 0
    timestamp_ms = viewer.now_ms()
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    frame[:, :] = (32, 72, 110)
    cv2 = viewer.cv2
    cv2.rectangle(frame, (360, 180), (760, 520), (70, 110, 180), -1)
    matrix = np.full((viewer.MATRIX_HEIGHT, viewer.MATRIX_WIDTH), 25.0, dtype=np.float32)
    matrix[40:82, 58:125] = max_c
    row = {
        "seq": f"test_{int(max_c * 10)}",
        "device_time_ms": timestamp_ms,
        "pc_receive_time_ms": timestamp_ms,
        "matrix_max_c": max_c,
        "matrix_min_c": 25.0,
        "matrix_avg_c": float(matrix.mean()),
    }
    state.latest_rgb_frame = frame
    state.latest_ir_frame = frame
    state.latest_frame_time_ms = timestamp_ms
    state.latest_matrix_row = row
    state.latest_matrix_values = matrix
    state.matrix_history.append((row, matrix))
    state.latest_global = {
        "pc_receive_time_ms": timestamp_ms,
        "max_c": max_c,
        "avg_c": float(matrix.mean()),
        "source": "ALERT_PIPELINE_TEST",
    }
    state.global_history.append(dict(state.latest_global))
    return state


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def test_alert_pipeline(output_dir: Path) -> dict:
    state = build_state(output_dir, 85.0)
    alert = viewer.process_alert_event(
        state,
        "pipeline_test",
        "dummy",
        None,
        sample_count=1,
        sample_interval_ms=10,
        sample_window_s=0.5,
        tile_size=640,
        overlap=96,
        critical_c=80.0,
        stop_event=threading.Event(),
    )
    require(alert["status"] == "complete", "alert status must be complete")
    require(alert["email_required"] is True, "85C alert must require email")
    require(alert["ntfy_required"] is True, "85C alert must require ntfy")
    require(alert["risk_type"] in {"critical_temperature", "potential_fire_risk"}, "unexpected risk type")
    require(alert["detection_count"] > 0, "dummy tiled inference should produce detections")
    require(state.latest_alert_detection_jpeg is not None, "detection JPEG missing")
    require(state.latest_alert_ir_jpeg is not None, "IR JPEG missing")
    require((output_dir / "alerts" / "pipeline_test" / "summary.json").exists(), "summary JSON missing")
    require((output_dir / "alerts" / "pipeline_test" / "detection_frame.jpg").exists(), "detection image missing")
    require((output_dir / "alerts" / "pipeline_test" / "ir_frame.jpg").exists(), "IR frame missing")
    return alert


def test_no_email_below_critical(output_dir: Path) -> dict:
    state = build_state(output_dir, 65.0)
    alert = viewer.process_alert_event(
        state,
        "below_critical_test",
        "dummy",
        None,
        sample_count=1,
        sample_interval_ms=10,
        sample_window_s=0.5,
        tile_size=640,
        overlap=96,
        critical_c=80.0,
        stop_event=threading.Event(),
    )
    require(alert["status"] == "complete", "below-critical alert status must be complete")
    require(alert["email_required"] is False, "65C alert must not require email")
    require(alert["ntfy_required"] is False, "65C alert must not require ntfy")
    return alert


def test_combustible_material_requires_phone_alert() -> None:
    result = viewer.classify_alert_risk(65.0, 32.0, [], [{"class_name": "cardboard", "conf": 0.91}], 80.0)
    require(result["risk_type"] == "potential_fire_risk", "combustible material risk was not classified")
    require(result["ntfy_required"] is True, "combustible material above 55 C must require phone alert")


def test_no_combustible_is_screen_warning_only() -> None:
    result = viewer.classify_alert_risk(65.0, 32.0, [], [{"class_name": "person", "conf": 0.91}], 80.0)
    require(result["risk_type"] == "elevated_temperature_no_combustible", "screen warning risk was not classified")
    require(result["severity"] == "warning", "no-combustible result must be an on-screen warning")
    require(result["ntfy_required"] is False, "no-combustible result below 80 C must not alert the phone")


def test_critical_temperature_always_requires_phone_alert() -> None:
    result = viewer.classify_alert_risk(80.0, 35.0, [], [], 80.0)
    require(result["risk_type"] == "critical_temperature", "critical temperature override was not classified")
    require(result["ntfy_required"] is True, "80 C must always require phone alert")


def test_temperature_video_offset_matching(tmp_dir: Path) -> None:
    state = build_state(tmp_dir, 65.0)
    sample_time = int(state.latest_global["pc_receive_time_ms"])
    state.temperature_video_offset_ms = 1000
    state.max_temp_frame_delta_ms = 700
    matched = viewer.nearest_global_sample(state, sample_time + 1000)
    rejected = viewer.nearest_global_sample(state, sample_time + 1800)
    require(matched is not None, "configured temperature/video offset did not match the corresponding frame")
    require(rejected is None, "temperature outside the strict compensated window was not rejected")


def test_continuous_evidence(output_dir: Path) -> list[dict]:
    alerts: list[dict] = []
    state = build_state(output_dir, 85.0)
    for idx in range(3):
        timestamp_ms = viewer.now_ms() + idx * 1000
        state.latest_frame_time_ms = timestamp_ms
        if state.latest_global is not None:
            state.latest_global["pc_receive_time_ms"] = timestamp_ms
            state.global_history.append(dict(state.latest_global))
        frames, matrices = viewer.collect_alert_samples(state, 1, 10, 0.5, threading.Event())
        alert = viewer.process_alert_event(
            state,
            f"continuous_test_{idx}",
            "dummy",
            None,
            sample_count=1,
            sample_interval_ms=10,
            sample_window_s=0.5,
            tile_size=640,
            overlap=96,
            critical_c=80.0,
            stop_event=threading.Event(),
            frames=frames,
            matrices=matrices,
            send_remote_alert=False,
        )
        alerts.append(alert)
    for idx in range(3):
        event_dir = output_dir / "alerts" / f"continuous_test_{idx}"
        require((event_dir / "detection_frame.jpg").exists(), f"continuous detection frame missing {idx}")
        require((event_dir / "ir_frame.jpg").exists(), f"continuous IR frame missing {idx}")
        require((event_dir / "summary.json").exists(), f"continuous summary missing {idx}")
    return alerts


def test_ntfy() -> tuple[bool, str]:
    alert = {
        "event_id": "ntfy_test",
        "created_ms": viewer.now_ms(),
        "risk_type": "ntfy_test",
        "severity": "critical",
        "global_max_c": 85.0,
        "global_avg_c": 30.0,
        "labels": ["test"],
        "detections": [{"class_name": "test", "conf": 1.0, "box_max_c": 85.0, "box_avg_c": 65.0}],
    }
    return viewer.send_alert_ntfy(alert)


def test_email(output_dir: Path) -> tuple[bool, str]:
    required = ["H30T_SMTP_HOST", "H30T_SMTP_USER", "H30T_SMTP_PASSWORD"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        return False, "skipped, missing " + ", ".join(missing)
    alert = {
        "event_id": "email_test",
        "risk_type": "email_test",
        "severity": "critical",
        "global_max_c": 85.0,
        "global_avg_c": 30.0,
        "max_box_c": 85.0,
        "max_box_avg_c": 65.0,
        "reasons": ["H30T email configuration test"],
        "detections": [{"class_name": "test", "conf": 1.0, "box_max_c": 85.0, "box_avg_c": 65.0}],
    }
    image = output_dir / "alerts" / "pipeline_test" / "detection_frame.jpg"
    return viewer.send_alert_email(alert, [image])


def capture_rtmp_frame(url: str, seconds: float = 8.0) -> np.ndarray:
    cap = viewer.cv2.VideoCapture(url)
    cap.set(viewer.cv2.CAP_PROP_BUFFERSIZE, 1)
    deadline = time.time() + seconds
    frame = None
    while time.time() < deadline:
        ok, candidate = cap.read() if cap.isOpened() else (False, None)
        if ok and candidate is not None:
            frame = candidate
            break
        time.sleep(0.02)
    cap.release()
    if frame is None:
        raise RuntimeError(f"could not read RTMP frame from {url}")
    if frame.shape[1] >= 2:
        frame = frame[:, frame.shape[1] // 2:].copy()
    return frame


def test_deimv2_event(output_dir: Path, url: str) -> dict:
    from deimv2_runtime import DEIMv2Detector

    frame = capture_rtmp_frame(url)
    detector = DEIMv2Detector(
        Path(__file__).resolve().parents[1],
        "configs/deimv2/deimv2_dinov3_s_coco.yml",
        "weight/deimv2_dinov3_s_coco.pth",
        0.45,
        require_cuda=True,
        use_fp16=True,
    )
    state = build_state(output_dir, 85.0)
    state.latest_rgb_frame = frame
    state.latest_ir_frame = frame
    alert = viewer.process_alert_event(
        state,
        "deimv2_rtmp_test",
        "deimv2",
        detector,
        sample_count=1,
        sample_interval_ms=10,
        sample_window_s=0.5,
        tile_size=640,
        overlap=96,
        critical_c=80.0,
        stop_event=threading.Event(),
    )
    require(alert["status"] == "complete", "DEIMv2 RTMP alert status must be complete")
    require(alert["email_required"] is True, "85C DEIMv2 alert must require email")
    require((output_dir / "alerts" / "deimv2_rtmp_test" / "detection_frame.jpg").exists(), "DEIMv2 detection image missing")
    return alert


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline test for H30T high-temperature alert pipeline.")
    parser.add_argument("--output-dir", default="outputs/wireless_alert_test")
    parser.add_argument("--test-email", action="store_true")
    parser.add_argument("--test-ntfy", action="store_true")
    parser.add_argument("--test-continuous-evidence", action="store_true")
    parser.add_argument("--require-ntfy-sent", action="store_true")
    parser.add_argument("--test-deimv2-rtmp", action="store_true")
    parser.add_argument("--rtmp-url", default="rtmp://24.71.108.251:1935/live/m400")
    args = parser.parse_args()

    output_dir = viewer.ensure_dir(Path(args.output_dir))
    critical = test_alert_pipeline(output_dir)
    below = test_no_email_below_critical(output_dir)
    test_combustible_material_requires_phone_alert()
    test_no_combustible_is_screen_warning_only()
    test_critical_temperature_always_requires_phone_alert()
    test_temperature_video_offset_matching(output_dir)
    print(f"critical: risk={critical['risk_type']} max={critical['global_max_c']} ntfy_required={critical['ntfy_required']} ntfy_send_status={critical['ntfy_send_status']} email_status={critical['email_status']}")
    print(f"below_critical: risk={below['risk_type']} max={below['global_max_c']} ntfy_required={below['ntfy_required']}")
    if args.require_ntfy_sent:
        require(critical.get("ntfy_sent") is True, f"critical ntfy must be sent: {critical.get('ntfy_send_status')}")
    if args.test_ntfy:
        sent, status = test_ntfy()
        print(f"ntfy_test: sent={sent} status={status}")
        if args.require_ntfy_sent:
            require(sent, f"ntfy test must be sent: {status}")
    if args.test_continuous_evidence:
        alerts = test_continuous_evidence(output_dir)
        print(f"continuous_evidence_test: saved={len(alerts)} latest_ntfy_status={alerts[-1]['ntfy_send_status']}")
    if args.test_email:
        sent, status = test_email(output_dir)
        print(f"email_test: sent={sent} status={status}")
    if args.test_deimv2_rtmp:
        alert = test_deimv2_event(output_dir, args.rtmp_url)
        print(f"deimv2_rtmp_test: risk={alert['risk_type']} detections={alert['detection_count']} ntfy_required={alert['ntfy_required']} ntfy_send_status={alert['ntfy_send_status']} email_status={alert['email_status']}")


if __name__ == "__main__":
    main()
