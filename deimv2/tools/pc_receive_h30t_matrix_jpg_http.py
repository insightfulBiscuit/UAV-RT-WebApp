from __future__ import annotations

import argparse
import cgi
import gzip
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

import numpy as np

try:
    from dji_thermal_sdk import DjiThermalSdk, DjiThermalSdkError, MeasurementParams
except Exception as exc:
    DjiThermalSdk = None  # type: ignore[assignment]
    _THERMAL_SDK_IMPORT_ERROR = exc

    class DjiThermalSdkError(RuntimeError):
        pass

    class MeasurementParams:  # type: ignore[no-redef]
        def __init__(
            self,
            distance_m: float = 5.0,
            humidity_percent: float = 70.0,
            emissivity: float = 0.95,
            reflection_c: float = 25.0,
        ) -> None:
            self.distance_m = distance_m
            self.humidity_percent = humidity_percent
            self.emissivity = emissivity
            self.reflection_c = reflection_c
else:
    _THERMAL_SDK_IMPORT_ERROR = None
from h30t_matrix_utils import (
    MATRIX_HEIGHT,
    MATRIX_WIDTH,
    append_csv,
    ensure_dir,
    now_ms,
    parse_h30t_jpeg_matrix,
    parse_h30t_matrix_payload,
    matrix_stats_from_values,
    read_body_limited,
    safe_name,
    save_matrix_bin,
)


def _walk_dicts(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_dicts(child)


def _number(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def normalize_pilot2_temperature(cloud_message: dict[str, Any]) -> dict[str, Any]:
    """Normalize a raw Pilot 2 Cloud API aircraft OSD/property payload."""
    area = None
    thermal = None
    for item in _walk_dicts(cloud_message.get("data", cloud_message)):
        candidate_area = item.get("ir_metering_area")
        if isinstance(candidate_area, dict) and area is None:
            area = candidate_area
        if "thermal_global_temperature_max" in item or "thermal_global_temperature_min" in item:
            thermal = item

    min_point = area.get("min_temperature_point", {}) if area else {}
    max_point = area.get("max_temperature_point", {}) if area else {}
    area_min_c = _number(min_point.get("temperature")) if isinstance(min_point, dict) else None
    area_max_c = _number(max_point.get("temperature")) if isinstance(max_point, dict) else None
    global_min_c = _number(thermal.get("thermal_global_temperature_min")) if thermal else None
    global_max_c = _number(thermal.get("thermal_global_temperature_max")) if thermal else None
    min_c = global_min_c if global_min_c is not None else area_min_c
    max_c = global_max_c if global_max_c is not None else area_max_c
    avg_c = _number(area.get("aver_temperature")) if area else None
    if min_c is None and max_c is None and avg_c is None:
        raise ValueError("Pilot 2 payload has no infrared temperature properties")

    timestamp = cloud_message.get("timestamp", now_ms())
    try:
        device_time_ms = int(timestamp)
        if device_time_ms < 10_000_000_000:
            device_time_ms *= 1000
    except (TypeError, ValueError):
        device_time_ms = now_ms()

    # Area points are not the coordinates of the separate global extrema.
    min_x = _number(min_point.get("x")) if global_min_c is None and isinstance(min_point, dict) else None
    min_y = _number(min_point.get("y")) if global_min_c is None and isinstance(min_point, dict) else None
    max_x = _number(max_point.get("x")) if global_max_c is None and isinstance(max_point, dict) else None
    max_y = _number(max_point.get("y")) if global_max_c is None and isinstance(max_point, dict) else None
    return {
        "type": "h30t_global_temp",
        "device_time_ms": device_time_ms,
        "seq": cloud_message.get("bid") or cloud_message.get("tid") or device_time_ms,
        "source": "PILOT2_CLOUD_API",
        "transport_mode": "pilot2_cloud_http_bridge",
        "region_x": area.get("x") if area else None,
        "region_y": area.get("y") if area else None,
        "region_width": area.get("width") if area else None,
        "region_height": area.get("height") if area else None,
        "avg_c": avg_c,
        "min_c": min_c,
        "max_c": max_c,
        "min_point_x_raw": min_x,
        "min_point_y_raw": min_y,
        "max_point_x_raw": max_x,
        "max_point_y_raw": max_y,
        "min_point_x_px": round(min_x * (MATRIX_WIDTH - 1)) if min_x is not None else None,
        "min_point_y_px": round(min_y * (MATRIX_HEIGHT - 1)) if min_y is not None else None,
        "max_point_x_px": round(max_x * (MATRIX_WIDTH - 1)) if max_x is not None else None,
        "max_point_y_px": round(max_y * (MATRIX_HEIGHT - 1)) if max_y is not None else None,
        "width": MATRIX_WIDTH,
        "height": MATRIX_HEIGHT,
    }

MATRIX_SUMMARY_FIELDS = [
    "seq",
    "device_time_ms",
    "pc_receive_time_ms",
    "jpg_path",
    "matrix_path",
    "matrix_min_c",
    "matrix_max_c",
    "matrix_avg_c",
    "matrix_p50_c",
    "matrix_p95_c",
    "matrix_p99_c",
    "matrix_min_x",
    "matrix_min_y",
    "matrix_max_x",
    "matrix_max_y",
    "matrix_source",
    "extract_ms",
    "total_receive_to_matrix_ms",
]

_THERMAL_SDK: DjiThermalSdk | None | bool = None


def log_safe(message: str) -> None:
    print(message.encode("ascii", "backslashreplace").decode("ascii"), flush=True)


def get_thermal_sdk(enabled: bool, library_path: str | None) -> DjiThermalSdk | None:
    global _THERMAL_SDK
    if not enabled:
        return None
    if DjiThermalSdk is not None and isinstance(_THERMAL_SDK, DjiThermalSdk):
        return _THERMAL_SDK
    if _THERMAL_SDK is False:
        return None
    if DjiThermalSdk is None:
        _THERMAL_SDK = False
        log_safe(f"[thermal-sdk] unavailable: {_THERMAL_SDK_IMPORT_ERROR}; falling back to APP3 apparent matrix")
        return None
    try:
        _THERMAL_SDK = DjiThermalSdk(library_path)
        log_safe(f"[thermal-sdk] loaded {getattr(_THERMAL_SDK, 'library_path', '')}")
        return _THERMAL_SDK
    except Exception as exc:
        _THERMAL_SDK = False
        log_safe(f"[thermal-sdk] unavailable: {exc}; falling back to APP3 apparent matrix")
        return None


def handle_h30t_jpg_upload(
    fields: dict[str, str],
    filename: str,
    jpg_bytes: bytes,
    output_dir: Path,
    offset_c: float,
    thermal_sdk_enabled: bool = True,
    thermal_sdk_library: str | None = None,
    measurement_params: MeasurementParams | None = None,
) -> dict:
    receive_ms = now_ms()
    seq = fields.get("seq", str(receive_ms))
    device_time_ms = fields.get("device_time_ms", "")
    stem = f"seq_{safe_name(seq)}_{safe_name(filename)}"
    jpg_dir = ensure_dir(output_dir / "h30t_jpg")
    matrix_dir = ensure_dir(output_dir / "matrices")
    jpg_path = jpg_dir / f"{stem}.jpg"
    matrix_path = matrix_dir / f"{stem}_float32c_{MATRIX_WIDTH}x{MATRIX_HEIGHT}.bin"
    jpg_path.write_bytes(jpg_bytes)

    started = now_ms()
    payload = b""
    sdk = get_thermal_sdk(thermal_sdk_enabled, thermal_sdk_library)
    if sdk is not None:
        try:
            _values, sdk_ms = sdk.measure_rjpeg(jpg_bytes, measurement_params)
            if _values.shape != (MATRIX_HEIGHT, MATRIX_WIDTH):
                raise DjiThermalSdkError(f"unexpected SDK matrix shape {_values.shape}")
            stats = matrix_stats_from_values(_values, extract_ms=sdk_ms, source="DJI_THERMAL_SDK")
        except Exception as exc:
            log_safe(f"[thermal-sdk] measurement failed: {exc}; falling back to APP3 apparent matrix")
            payload, _values, stats = parse_h30t_jpeg_matrix(jpg_bytes, offset_c=offset_c)
    else:
        payload, _values, stats = parse_h30t_jpeg_matrix(jpg_bytes, offset_c=offset_c)
    np.asarray(_values, dtype=np.float32).tofile(matrix_path)
    finished = now_ms()

    row = {
        "seq": seq,
        "device_time_ms": device_time_ms,
        "pc_receive_time_ms": receive_ms,
        "jpg_path": str(jpg_path),
        "matrix_path": str(matrix_path),
        "matrix_min_c": f"{stats.min_c:.6f}",
        "matrix_max_c": f"{stats.max_c:.6f}",
        "matrix_avg_c": f"{stats.avg_c:.6f}",
        "matrix_p50_c": f"{stats.p50_c:.6f}",
        "matrix_p95_c": f"{stats.p95_c:.6f}",
        "matrix_p99_c": f"{stats.p99_c:.6f}",
        "matrix_min_x": stats.min_x,
        "matrix_min_y": stats.min_y,
        "matrix_max_x": stats.max_x,
        "matrix_max_y": stats.max_y,
        "matrix_source": stats.source,
        "extract_ms": f"{stats.extract_ms:.3f}",
        "total_receive_to_matrix_ms": finished - started,
    }
    append_csv(output_dir / "matrix_summary.csv", MATRIX_SUMMARY_FIELDS, row)
    return {"row": row, "payload": payload, "stats": stats, "values": _values}


def handle_h30t_matrix_upload(
    fields: dict[str, str],
    filename: str,
    payload: bytes,
    output_dir: Path,
    offset_c: float,
) -> dict:
    receive_ms = now_ms()
    seq = fields.get("seq", str(receive_ms))
    device_time_ms = fields.get("device_time_ms", "")
    stem = f"seq_{safe_name(seq)}_{safe_name(filename)}"
    matrix_dir = ensure_dir(output_dir / "matrices")
    matrix_path = matrix_dir / f"{stem}_u16le_{MATRIX_WIDTH}x{MATRIX_HEIGHT}.bin"
    started = now_ms()
    values, stats = parse_h30t_matrix_payload(payload, offset_c=offset_c)
    save_matrix_bin(matrix_path, payload)
    finished = now_ms()
    row = {
        "seq": seq,
        "device_time_ms": device_time_ms,
        "pc_receive_time_ms": receive_ms,
        "jpg_path": "",
        "matrix_path": str(matrix_path),
        "matrix_min_c": f"{stats.min_c:.6f}",
        "matrix_max_c": f"{stats.max_c:.6f}",
        "matrix_avg_c": f"{stats.avg_c:.6f}",
        "matrix_p50_c": f"{stats.p50_c:.6f}",
        "matrix_p95_c": f"{stats.p95_c:.6f}",
        "matrix_p99_c": f"{stats.p99_c:.6f}",
        "matrix_min_x": stats.min_x,
        "matrix_min_y": stats.min_y,
        "matrix_max_x": stats.max_x,
        "matrix_max_y": stats.max_y,
        "extract_ms": f"{stats.extract_ms:.3f}",
        "total_receive_to_matrix_ms": finished - started,
    }
    append_csv(output_dir / "matrix_summary.csv", MATRIX_SUMMARY_FIELDS, row)
    return {"row": row, "payload": payload, "stats": stats, "values": values}


def make_handler(
    output_dir: Path,
    offset_c: float,
    callback: Callable[[dict], None] | None = None,
    global_callback: Callable[[dict], None] | None = None,
    thermal_sdk_enabled: bool = True,
    thermal_sdk_library: str | None = None,
    measurement_params: MeasurementParams | None = None,
    allow_matrix_upload: bool = True,
):
    class UploadHandler(BaseHTTPRequestHandler):
        server_version = "H30TMatrixReceiver/1.0"

        def do_POST(self) -> None:
            if self.path in {"/upload_h30t_matrix", "/upload_h30t_jpg"} and not allow_matrix_upload:
                self.send_error(410, "temperature matrix storage is disabled")
                return
            if self.path == "/upload_pilot2_properties":
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                    body_bytes = read_body_limited(self.rfile, content_length, max_bytes=1024 * 1024)
                    cloud_message = json.loads(body_bytes.decode("utf-8"))
                    message = normalize_pilot2_temperature(cloud_message)
                    if global_callback:
                        global_callback(message)
                    body = json.dumps({"ok": True, "normalized": message}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)
                    self.close_connection = True
                except Exception as exc:
                    self.send_error(400, str(exc))
                    log_safe(f"[pilot2-cloud] properties rejected: {exc}")
                return
            if self.path == "/upload_h30t_global":
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                    body_bytes = read_body_limited(self.rfile, content_length, max_bytes=64 * 1024)
                    message = json.loads(body_bytes.decode("utf-8"))
                    if message.get("type") != "h30t_global_temp":
                        raise ValueError("expected type=h30t_global_temp")
                    if global_callback:
                        global_callback(message)
                    body = b'{"ok":true}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)
                    self.close_connection = True
                except Exception as exc:
                    self.send_error(400, str(exc))
                    log_safe(f"[http-global] upload failed: {exc}")
                return
            if self.path == "/upload_h30t_matrix":
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                    compressed = read_body_limited(self.rfile, content_length, max_bytes=8 * 1024 * 1024)
                    payload = gzip.decompress(compressed) if self.headers.get("Content-Encoding", "").lower() == "gzip" else compressed
                    fields = {
                        "seq": self.headers.get("X-H30T-Seq", ""),
                        "device_time_ms": self.headers.get("X-H30T-Device-Time-Ms", ""),
                    }
                    filename = self.headers.get("X-H30T-Filename", "matrix.bin")
                    content_type = self.headers.get("Content-Type", "")
                    if payload[:2] == b"\xff\xd8" or "jpeg" in content_type.lower():
                        result = handle_h30t_jpg_upload(
                            fields,
                            filename,
                            payload,
                            output_dir,
                            offset_c,
                            thermal_sdk_enabled,
                            thermal_sdk_library,
                            measurement_params,
                        )
                    else:
                        result = handle_h30t_matrix_upload(fields, filename, payload, output_dir, offset_c)
                    if callback:
                        callback(result)
                    row = result["row"]
                    body = json.dumps({"ok": True, "seq": row["seq"], "matrix_avg_c": row["matrix_avg_c"]}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)
                    self.close_connection = True
                    log_safe(
                        f"[http-matrix] seq={row['seq']} avg={row['matrix_avg_c']} compressed_bytes={len(compressed)} extract_ms={row['extract_ms']}",
                    )
                except Exception as exc:
                    self.send_error(500, str(exc))
                    log_safe(f"[http-matrix] upload failed: {exc}")
                return
            if self.path != "/upload_h30t_jpg":
                self.send_error(404, "unknown path")
                return
            try:
                content_type = self.headers.get("Content-Type", "")
                ctype, pdict = cgi.parse_header(content_type)
                if ctype != "multipart/form-data":
                    self.send_error(400, "expected multipart/form-data")
                    return
                pdict["boundary"] = pdict["boundary"].encode("utf-8")
                form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST"})
                file_item = form["file"]
                filename = getattr(file_item, "filename", None) or f"h30t_{now_ms()}.jpg"
                jpg_bytes = file_item.file.read()
                fields = {}
                for key in form.keys():
                    if key == "file":
                        continue
                    item = form[key]
                    fields[key] = item.value if not isinstance(item, list) else item[0].value
                result = handle_h30t_jpg_upload(
                    fields,
                    filename,
                    jpg_bytes,
                    output_dir,
                    offset_c,
                    thermal_sdk_enabled,
                    thermal_sdk_library,
                    measurement_params,
                )
                if callback:
                    callback(result)
                row = result["row"]
                body = json.dumps({"ok": True, "seq": row["seq"], "matrix_avg_c": row["matrix_avg_c"]}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                log_safe(
                    f"[http] seq={row['seq']} avg={row['matrix_avg_c']} min={row['matrix_min_c']} max={row['matrix_max_c']} extract_ms={row['extract_ms']}",
                )
            except Exception as exc:
                self.send_error(500, str(exc))
                log_safe(f"[http] upload failed: {exc}")

        def log_message(self, fmt: str, *args) -> None:
            return

    return UploadHandler


def run_http_receiver(host: str, port: int, output_dir: Path, offset_c: float = 273.15, thermal_sdk_library: str | None = None) -> None:
    ensure_dir(output_dir)
    server = ThreadingHTTPServer((host, port), make_handler(output_dir, offset_c, thermal_sdk_library=thermal_sdk_library))
    log_safe(f"[http] listening on {host}:{port}, writing {output_dir}")
    server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Receive H30T IR JPG uploads and extract APP3 temperature matrices.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--output-dir", default="outputs/wireless")
    parser.add_argument("--offset-c", type=float, default=273.15)
    parser.add_argument("--thermal-sdk-lib", default=None)
    args = parser.parse_args()
    run_http_receiver(args.host, args.port, Path(args.output_dir), args.offset_c, args.thermal_sdk_lib)


if __name__ == "__main__":
    main()
