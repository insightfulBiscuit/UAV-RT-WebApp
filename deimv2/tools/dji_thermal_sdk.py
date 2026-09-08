from __future__ import annotations

import ctypes
import os
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np


class DjiThermalSdkError(RuntimeError):
    pass


@dataclass(frozen=True)
class MeasurementParams:
    distance_m: float = 5.0
    humidity_percent: float = 70.0
    emissivity: float = 0.95
    reflection_c: float = 25.0


class _DirpResolution(ctypes.Structure):
    _fields_ = [("width", ctypes.c_int32), ("height", ctypes.c_int32)]


class _DirpMeasurementParams(ctypes.Structure):
    _fields_ = [
        ("distance", ctypes.c_float),
        ("humidity", ctypes.c_float),
        ("emissivity", ctypes.c_float),
        ("reflection", ctypes.c_float),
    ]


class DjiThermalSdk:
    def __init__(self, library_path: str | os.PathLike[str] | None = None) -> None:
        path = self._resolve_library(library_path)
        self.library_path = path
        self._dll_dir_context = None
        if path.parent.exists() and hasattr(os, "add_dll_directory"):
            self._dll_dir_context = os.add_dll_directory(str(path.parent))
        self._dll = ctypes.CDLL(str(path))
        self._configure_symbols()

    @staticmethod
    def _resolve_library(library_path: str | os.PathLike[str] | None) -> Path:
        candidates: list[Path] = []
        if library_path:
            candidates.append(Path(library_path))
        for env_name in ("DJI_THERMAL_SDK_LIB", "DIRP_LIB_PATH"):
            value = os.environ.get(env_name)
            if value:
                candidates.append(Path(value))
        root = os.environ.get("DJI_THERMAL_SDK_ROOT")
        if root:
            base = Path(root)
            candidates.extend(
                [
                    base / "tsdk-core" / "lib" / "windows" / "release_x64" / "libdirp.dll",
                    base / "utility" / "bin" / "windows" / "release_x64" / "libdirp.dll",
                    base / "lib" / "windows" / "x64" / "libdirp.dll",
                    base / "lib" / "x64" / "libdirp.dll",
                    base / "lib" / "libdirp.dll",
                    base / "bin" / "libdirp.dll",
                    base / "libdirp.dll",
                ]
            )
        repo_root = Path(__file__).resolve().parents[1]
        candidates.extend(
            [
                repo_root
                / "third_party"
                / "dji_thermal_sdk"
                / "dji_thermal_sdk_v1.8_20250829"
                / "tsdk-core"
                / "lib"
                / "windows"
                / "release_x64"
                / "libdirp.dll",
                Path("libdirp.dll"),
                Path("dirp.dll"),
            ]
        )
        for candidate in candidates:
            if candidate.exists() or candidate.name == str(candidate):
                return candidate
        raise DjiThermalSdkError(
            "DJI Thermal SDK library not found. Set DJI_THERMAL_SDK_LIB to libdirp.dll "
            "or DJI_THERMAL_SDK_ROOT to the SDK directory."
        )

    def _configure_symbols(self) -> None:
        self._dll.dirp_create_from_rjpeg.argtypes = [
            ctypes.POINTER(ctypes.c_uint8),
            ctypes.c_int32,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        self._dll.dirp_create_from_rjpeg.restype = ctypes.c_int32

        self._dll.dirp_destroy.argtypes = [ctypes.c_void_p]
        self._dll.dirp_destroy.restype = ctypes.c_int32

        self._dll.dirp_get_rjpeg_resolution.argtypes = [ctypes.c_void_p, ctypes.POINTER(_DirpResolution)]
        self._dll.dirp_get_rjpeg_resolution.restype = ctypes.c_int32

        self._dll.dirp_measure_ex.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_int32]
        self._dll.dirp_measure_ex.restype = ctypes.c_int32

        setter = getattr(self._dll, "dirp_set_measurement_params", None)
        if setter is not None:
            setter.argtypes = [ctypes.c_void_p, ctypes.POINTER(_DirpMeasurementParams)]
            setter.restype = ctypes.c_int32

    @staticmethod
    def _check(code: int, operation: str) -> None:
        if code != 0:
            raise DjiThermalSdkError(f"{operation} failed with DIRP code {code}")

    def measure_rjpeg(self, rjpeg_bytes: bytes, params: MeasurementParams | None = None) -> tuple[np.ndarray, float]:
        if len(rjpeg_bytes) < 4 or rjpeg_bytes[:2] != b"\xff\xd8":
            raise DjiThermalSdkError("input is not an R-JPEG/JPEG byte stream")

        started = time.perf_counter()
        data = (ctypes.c_uint8 * len(rjpeg_bytes)).from_buffer_copy(rjpeg_bytes)
        handle = ctypes.c_void_p()
        self._check(
            self._dll.dirp_create_from_rjpeg(data, len(rjpeg_bytes), ctypes.byref(handle)),
            "dirp_create_from_rjpeg",
        )
        try:
            if params is not None and hasattr(self._dll, "dirp_set_measurement_params"):
                native_params = _DirpMeasurementParams(
                    float(params.distance_m),
                    float(params.humidity_percent),
                    float(params.emissivity),
                    float(params.reflection_c),
                )
                self._check(
                    self._dll.dirp_set_measurement_params(handle, ctypes.byref(native_params)),
                    "dirp_set_measurement_params",
                )

            resolution = _DirpResolution()
            self._check(
                self._dll.dirp_get_rjpeg_resolution(handle, ctypes.byref(resolution)),
                "dirp_get_rjpeg_resolution",
            )
            if resolution.width <= 0 or resolution.height <= 0:
                raise DjiThermalSdkError(f"invalid R-JPEG resolution {resolution.width}x{resolution.height}")

            count = int(resolution.width) * int(resolution.height)
            out = (ctypes.c_float * count)()
            self._check(
                self._dll.dirp_measure_ex(handle, out, count * ctypes.sizeof(ctypes.c_float)),
                "dirp_measure_ex",
            )
            values = np.ctypeslib.as_array(out).copy().reshape((int(resolution.height), int(resolution.width)))
            return values.astype(np.float32, copy=False), (time.perf_counter() - started) * 1000.0
        finally:
            self._dll.dirp_destroy(handle)
