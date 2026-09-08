from __future__ import annotations

import csv
import os
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import numpy as np

MATRIX_WIDTH = 1280
MATRIX_HEIGHT = 1024
MATRIX_BYTES = MATRIX_WIDTH * MATRIX_HEIGHT * 2


@dataclass
class MatrixStats:
    min_c: float
    max_c: float
    avg_c: float
    p50_c: float
    p95_c: float
    p99_c: float
    min_x: int
    min_y: int
    max_x: int
    max_y: int
    extract_ms: float
    source: str = "APP3_APPARENT"


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def append_csv(path: Path, fieldnames: list[str], row: dict) -> None:
    ensure_dir(path.parent)
    exists = path.exists()
    if exists:
        with path.open("r", newline="", encoding="utf-8") as f:
            header = f.readline().strip()
        expected_header = ",".join(fieldnames)
        if header and header != expected_header:
            backup = path.with_name(f"{path.stem}_legacy_{int(time.time())}{path.suffix}")
            path.replace(backup)
            exists = False
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if not exists:
            writer.writeheader()
        writer.writerow(row)


def extract_app3_payload(jpeg_bytes: bytes) -> bytes:
    if len(jpeg_bytes) < 4 or jpeg_bytes[:2] != b"\xff\xd8":
        raise ValueError("input is not a JPEG")
    payload = bytearray()
    pos = 2
    while pos < len(jpeg_bytes):
        if jpeg_bytes[pos] != 0xFF:
            break
        while pos < len(jpeg_bytes) and jpeg_bytes[pos] == 0xFF:
            pos += 1
        if pos >= len(jpeg_bytes):
            break
        marker = jpeg_bytes[pos]
        pos += 1
        if 0xD0 <= marker <= 0xD9 or marker == 0x01:
            if marker == 0xD9:
                break
            continue
        if pos + 2 > len(jpeg_bytes):
            break
        seg_len = int.from_bytes(jpeg_bytes[pos : pos + 2], "big")
        seg_start = pos + 2
        seg_end = pos + seg_len
        if seg_end > len(jpeg_bytes):
            raise ValueError(f"bad JPEG segment marker=0x{marker:02x} pos={pos} len={seg_len}")
        if marker == 0xE3:
            payload.extend(jpeg_bytes[seg_start:seg_end])
        elif marker == 0xDA:
            break
        pos = seg_end
    if len(payload) != MATRIX_BYTES:
        raise ValueError(f"APP3 payload size {len(payload)} != expected {MATRIX_BYTES}")
    return bytes(payload)


def uint16le_to_celsius_values(payload: bytes, offset_c: float = 273.15) -> np.ndarray:
    if len(payload) != MATRIX_BYTES:
        raise ValueError(f"payload size {len(payload)} != expected {MATRIX_BYTES}")
    return np.frombuffer(payload, dtype="<u2").astype(np.float32) / 64.0 - offset_c


def percentile_sorted(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return float("nan")
    index = int(round((len(sorted_values) - 1) * p))
    index = max(0, min(index, len(sorted_values) - 1))
    return sorted_values[index]


def matrix_stats_from_values(values: list[float] | np.ndarray, extract_ms: float, source: str = "APP3_APPARENT") -> MatrixStats:
    array = np.asarray(values, dtype=np.float32)
    if array.size != MATRIX_WIDTH * MATRIX_HEIGHT:
        raise ValueError(f"unexpected matrix value count {array.size}, expected {MATRIX_WIDTH * MATRIX_HEIGHT}")
    array = array.reshape(-1)
    min_i = int(np.argmin(array))
    max_i = int(np.argmax(array))
    percentiles = np.percentile(array, [50, 95, 99])
    return MatrixStats(
        min_c=float(array[min_i]),
        max_c=float(array[max_i]),
        avg_c=float(np.mean(array)),
        p50_c=float(percentiles[0]),
        p95_c=float(percentiles[1]),
        p99_c=float(percentiles[2]),
        min_x=min_i % MATRIX_WIDTH,
        min_y=min_i // MATRIX_WIDTH,
        max_x=max_i % MATRIX_WIDTH,
        max_y=max_i // MATRIX_WIDTH,
        extract_ms=extract_ms,
        source=source,
    )


def parse_h30t_matrix_payload(payload: bytes, offset_c: float = 273.15) -> tuple[np.ndarray, MatrixStats]:
    started = time.perf_counter()
    values = uint16le_to_celsius_values(payload, offset_c=offset_c)
    extract_ms = (time.perf_counter() - started) * 1000.0
    stats = matrix_stats_from_values(values, extract_ms=extract_ms, source="APP3_APPARENT")
    stats.extract_ms = (time.perf_counter() - started) * 1000.0
    return values, stats


def parse_h30t_jpeg_matrix(jpeg_bytes: bytes, offset_c: float = 273.15) -> tuple[bytes, np.ndarray, MatrixStats]:
    payload = extract_app3_payload(jpeg_bytes)
    values, stats = parse_h30t_matrix_payload(payload, offset_c=offset_c)
    return payload, values, stats


def save_matrix_bin(path: Path, payload: bytes) -> None:
    ensure_dir(path.parent)
    path.write_bytes(payload)


def safe_name(value: str) -> str:
    keep = []
    for ch in value:
        if ch.isalnum() or ch in ("-", "_", "."):
            keep.append(ch)
        else:
            keep.append("_")
    return "".join(keep).strip("._") or "unknown"


def read_body_limited(stream: BinaryIO, length: int, max_bytes: int = 32 * 1024 * 1024) -> bytes:
    if length > max_bytes:
        raise ValueError(f"request too large: {length} > {max_bytes}")
    return stream.read(length)
