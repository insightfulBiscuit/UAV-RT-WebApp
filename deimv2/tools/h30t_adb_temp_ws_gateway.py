from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import queue
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, Optional, Tuple


THERMAL_MAX_RE = re.compile(r'"thermal_global_temperature_max"\s*:\s*(-?\d+(?:\.\d+)?)')
THERMAL_MIN_RE = re.compile(r'"thermal_global_temperature_min"\s*:\s*(-?\d+(?:\.\d+)?)')
BID_RE = re.compile(r'"bid"\s*:\s*"([^"]+)"')
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def now_ms() -> int:
    return int(time.time() * 1000)


def number(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None and value != "" else None
    except (TypeError, ValueError):
        return None


def safe_text(value: Any) -> str:
    return str(value).encode("ascii", errors="backslashreplace").decode("ascii")


def walk_dicts(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_dicts(child)


def normalize_from_cloud_message(message: dict[str, Any]) -> Optional[dict[str, Any]]:
    thermal = None
    for item in walk_dicts(message.get("data", message)):
        if isinstance(item, dict) and (
            "thermal_global_temperature_max" in item or "thermal_global_temperature_min" in item
        ):
            thermal = item
            break
    if thermal is None:
        return None
    min_c = number(thermal.get("thermal_global_temperature_min"))
    max_c = number(thermal.get("thermal_global_temperature_max"))
    if min_c is None and max_c is None:
        return None
    avg_c = number(thermal.get("thermal_global_temperature_avg"))
    if avg_c is None and min_c is not None and max_c is not None:
        avg_c = (min_c + max_c) / 2.0
    timestamp = message.get("timestamp", now_ms())
    try:
        device_time_ms = int(timestamp)
        if device_time_ms < 10_000_000_000:
            device_time_ms *= 1000
    except (TypeError, ValueError):
        device_time_ms = now_ms()
    return {
        "type": "h30t_global_temp",
        "device_time_ms": device_time_ms,
        "seq": message.get("bid") or message.get("tid") or device_time_ms,
        "source": "PILOT2_LOGCAT_OSD",
        "transport_mode": "adb_logcat_site_gateway",
        "avg_c": avg_c if avg_c is not None else "",
        "min_c": min_c if min_c is not None else "",
        "max_c": max_c if max_c is not None else "",
        "min_point_x_raw": "",
        "min_point_y_raw": "",
        "max_point_x_raw": "",
        "max_point_y_raw": "",
        "width": 1280,
        "height": 1024,
    }


def normalize_from_line_regex(line: str) -> Optional[dict[str, Any]]:
    max_match = THERMAL_MAX_RE.search(line)
    min_match = THERMAL_MIN_RE.search(line)
    if not max_match and not min_match:
        return None
    bid_match = BID_RE.search(line)
    min_c = float(min_match.group(1)) if min_match else None
    max_c = float(max_match.group(1)) if max_match else None
    avg_c = (min_c + max_c) / 2.0 if min_c is not None and max_c is not None else None
    return {
        "type": "h30t_global_temp",
        "device_time_ms": now_ms(),
        "seq": bid_match.group(1) if bid_match else now_ms(),
        "source": "PILOT2_LOGCAT_OSD",
        "transport_mode": "adb_logcat_site_gateway",
        "avg_c": avg_c if avg_c is not None else "",
        "min_c": min_c if min_c is not None else "",
        "max_c": max_c if max_c is not None else "",
        "min_point_x_raw": "",
        "min_point_y_raw": "",
        "max_point_x_raw": "",
        "max_point_y_raw": "",
        "width": 1280,
        "height": 1024,
    }


def parse_logcat_line(line: str) -> Optional[dict[str, Any]]:
    if "thermal_global_temperature_" not in line:
        return None
    json_start = line.find("{")
    if json_start >= 0:
        decoder = json.JSONDecoder()
        try:
            message, _end = decoder.raw_decode(line[json_start:])
            if isinstance(message, dict):
                normalized = normalize_from_cloud_message(message)
                if normalized is not None:
                    return normalized
        except json.JSONDecodeError:
            pass
    return normalize_from_line_regex(line)


def ws_encode(payload: bytes, opcode: int = 1, mask: bool = False) -> bytes:
    first = 0x80 | opcode
    length = len(payload)
    if length < 126:
        header = bytes([first, (0x80 if mask else 0) | length])
    elif length < 65536:
        header = bytes([first, (0x80 if mask else 0) | 126]) + length.to_bytes(2, "big")
    else:
        header = bytes([first, (0x80 if mask else 0) | 127]) + length.to_bytes(8, "big")
    if not mask:
        return header + payload
    key = os.urandom(4)
    masked = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return header + key + masked


def recv_exact(sock: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("socket closed")
        data.extend(chunk)
    return bytes(data)


def ws_read(sock: socket.socket) -> Tuple[int, bytes]:
    first, second = recv_exact(sock, 2)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(recv_exact(sock, 2), "big")
    elif length == 127:
        length = int.from_bytes(recv_exact(sock, 8), "big")
    key = recv_exact(sock, 4) if masked else b""
    payload = recv_exact(sock, length) if length else b""
    if masked:
        payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def ws_send_json(sock: socket.socket, payload: dict[str, Any]) -> None:
    sock.sendall(ws_encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")))


def ws_recv_json(sock: socket.socket) -> Optional[dict[str, Any]]:
    opcode, payload = ws_read(sock)
    if opcode == 8:
        return None
    if opcode == 9:
        sock.sendall(ws_encode(payload, opcode=10))
        return {}
    if opcode != 1:
        return {}
    data = json.loads(payload.decode("utf-8"))
    return data if isinstance(data, dict) else {}


def ws_client_connect(url: str, timeout_s: float = 10.0) -> socket.socket:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "ws":
        raise ValueError("only ws:// URLs are supported in the minimal gateway")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 80
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    sock = socket.create_connection((host, port), timeout=timeout_s)
    sock.settimeout(timeout_s)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(request.encode("ascii"))
    response = b""
    while b"\r\n\r\n" not in response:
        response += sock.recv(4096)
    if b" 101 " not in response.split(b"\r\n", 1)[0]:
        raise ConnectionError(f"websocket upgrade failed: {response[:120]!r}")
    return sock


class RelayState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.latest: Optional[dict[str, Any]] = None
        self.subscribers: set[socket.socket] = set()
        self.publish_count = 0

    def publish(self, payload: dict[str, Any]) -> None:
        with self.lock:
            payload = dict(payload)
            payload["relay_receive_time_ms"] = now_ms()
            self.latest = payload
            self.publish_count += 1
            subscribers = list(self.subscribers)
        dead = []
        for subscriber in subscribers:
            try:
                ws_send_json(subscriber, payload)
            except OSError:
                dead.append(subscriber)
        if dead:
            with self.lock:
                for subscriber in dead:
                    self.subscribers.discard(subscriber)


def parse_http_headers(sock: socket.socket) -> Tuple[str, dict[str, str]]:
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("closed before HTTP headers")
        data += chunk
        if len(data) > 65536:
            raise ValueError("HTTP headers too large")
    head = data.decode("iso-8859-1")
    lines = head.split("\r\n")
    request_line = lines[0]
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.lower()] = value.strip()
    return request_line, headers


def server_handshake(sock: socket.socket, token: str) -> str:
    request_line, headers = parse_http_headers(sock)
    parts = request_line.split()
    if len(parts) < 2:
        raise ValueError("bad request line")
    path = parts[1]
    parsed = urllib.parse.urlparse(path)
    if token:
        supplied = urllib.parse.parse_qs(parsed.query).get("token", [""])[0]
        if supplied != token:
            sock.sendall(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
            raise PermissionError("bad token")
    key = headers.get("sec-websocket-key", "")
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    sock.sendall(response.encode("ascii"))
    return parsed.path


def handle_client(sock: socket.socket, state: RelayState, token: str) -> None:
    try:
        path = server_handshake(sock, token)
        if path == "/publish":
            while True:
                payload = ws_recv_json(sock)
                if payload is None:
                    break
                if not payload:
                    continue
                state.publish(payload)
                print(f"[relay] publish seq={payload.get('seq')} max={payload.get('max_c')}", flush=True)
        elif path == "/subscribe":
            with state.lock:
                state.subscribers.add(sock)
                latest = dict(state.latest) if state.latest else None
            if latest:
                ws_send_json(sock, latest)
            while True:
                opcode, _payload = ws_read(sock)
                if opcode == 8:
                    break
        else:
            sock.close()
            return
    except Exception as exc:
        print(f"[relay] client ended: {safe_text(exc)}", flush=True)
    finally:
        with state.lock:
            state.subscribers.discard(sock)
        try:
            sock.close()
        except OSError:
            pass


def run_server(args: argparse.Namespace) -> None:
    state = RelayState()
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.host, args.port))
    server.listen(50)
    print(f"[relay] ws listening on {args.host}:{args.port} paths=/publish,/subscribe", flush=True)
    while True:
        sock, _addr = server.accept()
        threading.Thread(target=handle_client, args=(sock, state, args.token), daemon=True).start()


def adb_command(adb: str, serial: str) -> list[str]:
    command = [adb]
    if serial:
        command += ["-s", serial]
    command += ["logcat", "-v", "time", "-T", "1"]
    return command


def enqueue_stream(stream: Any, output: "queue.Queue[str]") -> None:
    for line in stream:
        output.put(line)


def run_publish_adb(args: argparse.Namespace) -> None:
    command = adb_command(args.adb, args.serial)
    sock: Optional[socket.socket] = None
    last_send_ms = 0
    last_payload: Optional[dict[str, Any]] = None
    while True:
        try:
            if sock is None:
                print(f"[field] connecting {args.vps_url}", flush=True)
                sock = ws_client_connect(args.vps_url, timeout_s=args.timeout_s)
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
            assert process.stdout is not None
            lines: queue.Queue[str] = queue.Queue()
            threading.Thread(target=enqueue_stream, args=(process.stdout, lines), daemon=True).start()
            while True:
                try:
                    line = lines.get(timeout=0.1)
                except queue.Empty:
                    if process.poll() is not None and lines.empty():
                        break
                    if last_payload and args.heartbeat_ms > 0 and now_ms() - last_send_ms >= args.heartbeat_ms:
                        heartbeat = dict(last_payload)
                        heartbeat["device_time_ms"] = now_ms()
                        heartbeat["seq"] = f"{heartbeat.get('seq')}:hold:{heartbeat['device_time_ms']}"
                        heartbeat["transport_mode"] = "adb_logcat_site_gateway_hold"
                        sock.sendall(ws_encode(json.dumps(heartbeat, separators=(",", ":")).encode("utf-8"), mask=True))
                        last_send_ms = now_ms()
                    continue
                payload = parse_logcat_line(line)
                if payload is None or now_ms() - last_send_ms < args.min_interval_ms:
                    continue
                payload["device_id"] = args.device_id
                sock.sendall(ws_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"), mask=True))
                last_payload = dict(payload)
                last_send_ms = now_ms()
                print(f"[field] sent seq={payload.get('seq')} max={payload.get('max_c')}", flush=True)
        except KeyboardInterrupt:
            return
        except Exception as exc:
            print(f"[field] reconnecting: {safe_text(exc)}", flush=True)
            try:
                if sock:
                    sock.close()
            except OSError:
                pass
            sock = None
            time.sleep(max(0.2, args.reconnect_s))


def post_json(url: str, payload: dict[str, Any], timeout_s: float) -> None:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        response.read()


def run_subscribe_inject(args: argparse.Namespace) -> None:
    while True:
        try:
            print(f"[remote] connecting {args.vps_url}", flush=True)
            sock = ws_client_connect(args.vps_url, timeout_s=args.timeout_s)
            with sock:
                while True:
                    payload = ws_recv_json(sock)
                    if payload is None:
                        break
                    if not payload:
                        continue
                    post_json(args.viewer_url, payload, args.timeout_s)
                    print(f"[remote] injected seq={payload.get('seq')} max={payload.get('max_c')}", flush=True)
        except KeyboardInterrupt:
            return
        except Exception as exc:
            print(f"[remote] reconnecting: {safe_text(exc)}", flush=True)
            time.sleep(max(0.2, args.reconnect_s))


def run_publish_json(args: argparse.Namespace) -> None:
    if args.payload_b64:
        payload_text = base64.b64decode(args.payload_b64).decode("utf-8")
    elif args.payload_json:
        payload_text = args.payload_json
    else:
        raise ValueError("publish-json requires --payload-json or --payload-b64")
    payload = json.loads(payload_text)
    sock = ws_client_connect(args.vps_url, timeout_s=args.timeout_s)
    with sock:
        sock.sendall(ws_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"), mask=True))
    print(f"[publish-json] sent seq={payload.get('seq')} max={payload.get('max_c')}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="H30T Pilot2 ADB temperature WebSocket gateway.")
    sub = parser.add_subparsers(dest="mode", required=True)

    server = sub.add_parser("server")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8092)
    server.add_argument("--token", default="")
    server.set_defaults(func=run_server)

    pub = sub.add_parser("publish-adb")
    pub.add_argument("--vps-url", required=True)
    pub.add_argument("--adb", default="adb")
    pub.add_argument("--serial", default="")
    pub.add_argument("--device-id", default="h30t")
    pub.add_argument("--min-interval-ms", type=int, default=900)
    pub.add_argument("--heartbeat-ms", type=int, default=1000)
    pub.add_argument("--timeout-s", type=float, default=10.0)
    pub.add_argument("--reconnect-s", type=float, default=1.0)
    pub.set_defaults(func=run_publish_adb)

    sub_inject = sub.add_parser("subscribe-inject")
    sub_inject.add_argument("--vps-url", required=True)
    sub_inject.add_argument("--viewer-url", default="http://127.0.0.1:8010/upload_h30t_global")
    sub_inject.add_argument("--timeout-s", type=float, default=10.0)
    sub_inject.add_argument("--reconnect-s", type=float, default=1.0)
    sub_inject.set_defaults(func=run_subscribe_inject)

    pub_json = sub.add_parser("publish-json")
    pub_json.add_argument("--vps-url", required=True)
    pub_json.add_argument("--payload-json", default="")
    pub_json.add_argument("--payload-b64", default="")
    pub_json.add_argument("--timeout-s", type=float, default=10.0)
    pub_json.set_defaults(func=run_publish_json)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
