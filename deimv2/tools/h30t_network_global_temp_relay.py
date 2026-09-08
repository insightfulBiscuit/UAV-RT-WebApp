from __future__ import annotations

import argparse
import json
import secrets
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from h30t_matrix_utils import append_csv, ensure_dir, now_ms, read_body_limited


GLOBAL_FIELDS = [
    "pc_receive_time_ms",
    "relay_receive_time_ms",
    "delay_ms",
    "type",
    "device_time_ms",
    "seq",
    "source",
    "transport_mode",
    "avg_c",
    "min_c",
    "max_c",
    "min_point_x_raw",
    "min_point_y_raw",
    "max_point_x_raw",
    "max_point_y_raw",
    "min_point_x_px",
    "min_point_y_px",
    "max_point_x_px",
    "max_point_y_px",
    "width",
    "height",
]


def safe_text(value: Any) -> str:
    return str(value).encode("ascii", errors="backslashreplace").decode("ascii")


class LatestTemperatureStore:
    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.csv_path = output_dir / "network_global_temperature.csv"
        self.lock = threading.Lock()
        self.latest: Optional[dict[str, Any]] = None
        self.count = 0

    def update(self, message: dict[str, Any]) -> dict[str, Any]:
        relay_time = now_ms()
        normalized = normalize_global_temperature(message)
        normalized["relay_receive_time_ms"] = relay_time
        device_time = normalized.get("device_time_ms")
        normalized["delay_ms"] = relay_time - int(device_time) if isinstance(device_time, int) else ""
        row = {field: normalized.get(field, "") for field in GLOBAL_FIELDS}
        row["pc_receive_time_ms"] = ""
        ensure_dir(self.output_dir)
        append_csv(self.csv_path, GLOBAL_FIELDS, row)
        with self.lock:
            self.latest = normalized
            self.count += 1
        return normalized

    def snapshot(self) -> Tuple[Optional[dict[str, Any]], int]:
        with self.lock:
            return (dict(self.latest) if self.latest else None, self.count)


def _number(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None and value != "" else None
    except (TypeError, ValueError):
        return None


def _walk_dicts(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_dicts(child)


def normalize_pilot2_properties(payload: dict[str, Any]) -> dict[str, Any]:
    area = None
    thermal = None
    for item in _walk_dicts(payload.get("data", payload)):
        candidate_area = item.get("ir_metering_area")
        if isinstance(candidate_area, dict) and area is None:
            area = candidate_area
        if "thermal_global_temperature_max" in item or "thermal_global_temperature_min" in item:
            thermal = item

    min_point = area.get("min_temperature_point", {}) if area else {}
    max_point = area.get("max_temperature_point", {}) if area else {}
    global_min_c = _number(thermal.get("thermal_global_temperature_min")) if thermal else None
    global_max_c = _number(thermal.get("thermal_global_temperature_max")) if thermal else None
    area_min_c = _number(min_point.get("temperature")) if isinstance(min_point, dict) else None
    area_max_c = _number(max_point.get("temperature")) if isinstance(max_point, dict) else None
    avg_c = _number(area.get("aver_temperature")) if area else None
    min_c = global_min_c if global_min_c is not None else area_min_c
    max_c = global_max_c if global_max_c is not None else area_max_c
    if min_c is None and max_c is None and avg_c is None:
        raise ValueError("payload has no global or IR metering temperature fields")

    timestamp = payload.get("timestamp", now_ms())
    try:
        device_time_ms = int(timestamp)
        if device_time_ms < 10_000_000_000:
            device_time_ms *= 1000
    except (TypeError, ValueError):
        device_time_ms = now_ms()

    max_x = _number(max_point.get("x")) if global_max_c is None and isinstance(max_point, dict) else None
    max_y = _number(max_point.get("y")) if global_max_c is None and isinstance(max_point, dict) else None
    min_x = _number(min_point.get("x")) if global_min_c is None and isinstance(min_point, dict) else None
    min_y = _number(min_point.get("y")) if global_min_c is None and isinstance(min_point, dict) else None
    return {
        "type": "h30t_global_temp",
        "device_time_ms": device_time_ms,
        "seq": payload.get("bid") or payload.get("tid") or device_time_ms,
        "source": "PILOT2_CLOUD_API",
        "transport_mode": "network_temp_relay",
        "avg_c": avg_c,
        "min_c": min_c,
        "max_c": max_c,
        "min_point_x_raw": min_x,
        "min_point_y_raw": min_y,
        "max_point_x_raw": max_x,
        "max_point_y_raw": max_y,
        "min_point_x_px": round(min_x * 1279) if min_x is not None else None,
        "min_point_y_px": round(min_y * 1023) if min_y is not None else None,
        "max_point_x_px": round(max_x * 1279) if max_x is not None else None,
        "max_point_y_px": round(max_y * 1023) if max_y is not None else None,
        "width": 1280,
        "height": 1024,
    }


def normalize_global_temperature(payload: dict[str, Any]) -> dict[str, Any]:
    if "thermal_global_temperature_max" in json.dumps(payload, separators=(",", ":")) or "ir_metering_area" in payload:
        return normalize_pilot2_properties(payload)

    max_c = _number(payload.get("max_c") if "max_c" in payload else payload.get("thermal_global_temperature_max"))
    min_c = _number(payload.get("min_c") if "min_c" in payload else payload.get("thermal_global_temperature_min"))
    avg_c = _number(payload.get("avg_c") if "avg_c" in payload else payload.get("aver_temperature"))
    if max_c is None:
        raise ValueError("expected max_c or thermal_global_temperature_max")
    if min_c is None:
        min_c = max_c
    if avg_c is None:
        avg_c = max_c

    timestamp = payload.get("device_time_ms", payload.get("timestamp", now_ms()))
    try:
        device_time_ms = int(timestamp)
        if device_time_ms < 10_000_000_000:
            device_time_ms *= 1000
    except (TypeError, ValueError):
        device_time_ms = now_ms()

    return {
        "type": "h30t_global_temp",
        "device_time_ms": device_time_ms,
        "seq": payload.get("seq") or payload.get("bid") or payload.get("tid") or device_time_ms,
        "source": payload.get("source") or "NETWORK_GLOBAL_TEMP",
        "transport_mode": payload.get("transport_mode") or "network_temp_relay",
        "avg_c": avg_c,
        "min_c": min_c,
        "max_c": max_c,
        "min_point_x_raw": payload.get("min_point_x_raw"),
        "min_point_y_raw": payload.get("min_point_y_raw"),
        "max_point_x_raw": payload.get("max_point_x_raw"),
        "max_point_y_raw": payload.get("max_point_y_raw"),
        "min_point_x_px": payload.get("min_point_x_px"),
        "min_point_y_px": payload.get("min_point_y_px"),
        "max_point_x_px": payload.get("max_point_x_px"),
        "max_point_y_px": payload.get("max_point_y_px"),
        "width": payload.get("width", 1280),
        "height": payload.get("height", 1024),
    }


def has_valid_token(handler: BaseHTTPRequestHandler, token: str) -> bool:
    if not token:
        return True
    auth = handler.headers.get("Authorization", "")
    if auth == f"Bearer {token}":
        return True
    if handler.headers.get("X-H30T-Token") == token:
        return True
    query_token = parse_qs(urlparse(handler.path).query).get("token", [""])[0]
    return query_token == token


def write_json(handler: BaseHTTPRequestHandler, status: int, body: dict[str, Any]) -> None:
    data = json.dumps(body, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.wfile.write(data)
    handler.close_connection = True


def make_handler(store: LatestTemperatureStore, token: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path in {"/health", "/latest"}:
                if not has_valid_token(self, token):
                    write_json(self, 401, {"ok": False, "error": "unauthorized"})
                    return
                latest, count = store.snapshot()
                if path == "/latest" and latest is None:
                    write_json(self, 404, {"ok": False, "count": count, "error": "no_temperature"})
                    return
                write_json(self, 200, {"ok": True, "count": count, "latest": latest})
                return
            write_json(self, 404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            if path not in {"/upload_h30t_global", "/upload_pilot2_properties"}:
                write_json(self, 404, {"ok": False, "error": "not_found"})
                return
            if not has_valid_token(self, token):
                write_json(self, 401, {"ok": False, "error": "unauthorized"})
                return
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                body = read_body_limited(self.rfile, content_length, max_bytes=1024 * 1024)
                payload = json.loads(body.decode("utf-8"))
                if path == "/upload_pilot2_properties":
                    message = normalize_pilot2_properties(payload)
                else:
                    message = normalize_global_temperature(payload)
                latest = store.update(message)
                print(
                    f"[relay] seq={latest.get('seq')} max={latest.get('max_c')} source={latest.get('source')}",
                    flush=True,
                )
                write_json(self, 200, {"ok": True, "latest": latest})
            except Exception as exc:
                print(f"[relay] rejected: {exc}", flush=True)
                write_json(self, 400, {"ok": False, "error": str(exc)})

    return Handler


def http_json(method: str, url: str, token: str = "", payload: Optional[dict[str, Any]] = None, timeout_s: float = 3.0) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return json.loads(response.read().decode("utf-8"))


def run_server(args: argparse.Namespace) -> None:
    store = LatestTemperatureStore(Path(args.output_dir))
    server = ThreadingHTTPServer((args.host, args.port), make_handler(store, args.token))
    print(f"[relay] listening on http://{args.host}:{args.port}", flush=True)
    if args.token:
        print("[relay] token auth enabled", flush=True)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
    thread.start()
    deadline = time.monotonic() + args.run_seconds if args.run_seconds > 0 else None
    try:
        while deadline is None or time.monotonic() < deadline:
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    server.shutdown()


def run_inject(args: argparse.Namespace) -> None:
    latest_key = ""
    endpoint = args.relay_url.rstrip("/") + "/latest"
    print(f"[inject] relay {endpoint} -> viewer {args.viewer_url}", flush=True)
    deadline = time.monotonic() + args.run_seconds if args.run_seconds > 0 else None
    while deadline is None or time.monotonic() < deadline:
        try:
            response = http_json("GET", endpoint, token=args.token, timeout_s=args.timeout_s)
            latest = response.get("latest")
            if isinstance(latest, dict):
                key = f"{latest.get('seq')}:{latest.get('device_time_ms')}:{latest.get('max_c')}"
                if args.repeat or key != latest_key:
                    http_json("POST", args.viewer_url, payload=latest, timeout_s=args.timeout_s)
                    latest_key = key
                    print(f"[inject] seq={latest.get('seq')} max={latest.get('max_c')}", flush=True)
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                print(f"[inject] http error {exc.code}: {exc.reason}", flush=True)
        except Exception as exc:
            print(f"[inject] waiting: {exc}", flush=True)
        time.sleep(max(0.05, args.interval_ms / 1000.0))


def run_simulate(args: argparse.Namespace) -> None:
    endpoint = args.relay_url.rstrip("/") + "/upload_h30t_global"
    deadline = time.monotonic() + args.run_seconds if args.run_seconds > 0 else None
    seq = 0
    while deadline is None or time.monotonic() < deadline:
        seq += 1
        max_c = args.base_c + ((seq - 1) % args.step_count) * args.step_c
        payload = {
            "type": "h30t_global_temp",
            "device_time_ms": now_ms(),
            "seq": f"sim-{seq}",
            "source": "NETWORK_TEMP_SIMULATOR",
            "transport_mode": "network_temp_relay",
            "avg_c": max_c - 2.0,
            "min_c": max_c - 5.0,
            "max_c": max_c,
        }
        http_json("POST", endpoint, token=args.token, payload=payload, timeout_s=args.timeout_s)
        print(f"[simulate] seq={payload['seq']} max={max_c}", flush=True)
        time.sleep(max(0.05, args.interval_ms / 1000.0))


def parse_ntfy_message(event: dict[str, Any]) -> Optional[dict[str, Any]]:
    if event.get("event") not in {None, "message"}:
        return None
    message = event.get("message")
    if not isinstance(message, str) or not message.strip():
        return None
    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    return normalize_global_temperature(payload)


def run_ntfy_inject(args: argparse.Namespace) -> None:
    url = args.ntfy_url.rstrip("/") + "/json"
    latest_key = ""
    print(f"[ntfy-inject] subscribe {url} -> viewer {args.viewer_url}", flush=True)
    while True:
        try:
            request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
            with urllib.request.urlopen(request, timeout=args.connect_timeout_s) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError as exc:
                        print(f"[ntfy-inject] bad event: {exc}", flush=True)
                        continue
                    try:
                        payload = parse_ntfy_message(event)
                    except Exception as exc:
                        print(f"[ntfy-inject] ignored message: {exc}", flush=True)
                        continue
                    if payload is None:
                        continue
                    key = f"{payload.get('seq')}:{payload.get('device_time_ms')}:{payload.get('max_c')}"
                    if key == latest_key:
                        continue
                    http_json("POST", args.viewer_url, payload=payload, timeout_s=args.timeout_s)
                    latest_key = key
                    print(
                        f"[ntfy-inject] seq={payload.get('seq')} max={payload.get('max_c')} source={payload.get('source')}",
                        flush=True,
                    )
        except KeyboardInterrupt:
            return
        except Exception as exc:
            print(f"[ntfy-inject] reconnecting: {exc}", flush=True)
            time.sleep(max(0.5, args.reconnect_ms / 1000.0))


def mqtt_encode_string(value: str) -> bytes:
    data = value.encode("utf-8")
    return len(data).to_bytes(2, "big") + data


def mqtt_encode_remaining_length(value: int) -> bytes:
    out = bytearray()
    while True:
        encoded = value % 128
        value //= 128
        if value > 0:
            encoded |= 128
        out.append(encoded)
        if value == 0:
            return bytes(out)


def mqtt_read_exact(sock: socket.socket, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise ConnectionError("mqtt socket closed")
        chunks.extend(chunk)
    return bytes(chunks)


def mqtt_read_packet(sock: socket.socket) -> Tuple[int, bytes]:
    header = mqtt_read_exact(sock, 1)[0]
    multiplier = 1
    remaining = 0
    while True:
        encoded = mqtt_read_exact(sock, 1)[0]
        remaining += (encoded & 127) * multiplier
        if (encoded & 128) == 0:
            break
        multiplier *= 128
        if multiplier > 128 * 128 * 128:
            raise ValueError("bad mqtt remaining length")
    return header, mqtt_read_exact(sock, remaining)


def mqtt_send_connect(sock: socket.socket, client_id: str, username: str, password: str, keepalive_s: int) -> None:
    variable = mqtt_encode_string("MQTT") + bytes([4, 0, keepalive_s >> 8, keepalive_s & 0xFF])
    flags = 0x02
    payload = mqtt_encode_string(client_id)
    if username:
        flags |= 0x80
        payload += mqtt_encode_string(username)
    if password:
        flags |= 0x40
        payload += mqtt_encode_string(password)
    variable = variable[:7] + bytes([flags]) + variable[8:]
    packet = bytes([0x10]) + mqtt_encode_remaining_length(len(variable) + len(payload)) + variable + payload
    sock.sendall(packet)
    header, body = mqtt_read_packet(sock)
    if header != 0x20 or len(body) < 2 or body[1] != 0:
        raise ConnectionError(f"mqtt CONNACK failed header=0x{header:02x} body={body.hex()}")


def mqtt_send_subscribe(sock: socket.socket, topic: str, packet_id: int = 1) -> None:
    variable = packet_id.to_bytes(2, "big")
    payload = mqtt_encode_string(topic) + b"\x00"
    packet = bytes([0x82]) + mqtt_encode_remaining_length(len(variable) + len(payload)) + variable + payload
    sock.sendall(packet)
    header, body = mqtt_read_packet(sock)
    if header != 0x90 or len(body) < 3 or body[2] == 0x80:
        raise ConnectionError(f"mqtt SUBACK failed header=0x{header:02x} body={body.hex()}")


def mqtt_parse_publish(header: int, body: bytes) -> Tuple[str, bytes, int, int]:
    if (header >> 4) != 3:
        raise ValueError("not a PUBLISH packet")
    qos = (header >> 1) & 0x03
    topic_len = int.from_bytes(body[:2], "big")
    topic = body[2 : 2 + topic_len].decode("utf-8", errors="replace")
    pos = 2 + topic_len
    packet_id = 0
    if qos:
        packet_id = int.from_bytes(body[pos : pos + 2], "big")
        pos += 2
    return topic, body[pos:], qos, packet_id


def mqtt_open(args: argparse.Namespace) -> socket.socket:
    raw = socket.create_connection((args.mqtt_host, args.mqtt_port), timeout=args.connect_timeout_s)
    raw.settimeout(args.socket_timeout_s)
    if args.tls:
        context = ssl.create_default_context()
        wrapped = context.wrap_socket(raw, server_hostname=args.mqtt_host)
        return wrapped
    return raw


def run_cloud_mqtt_inject(args: argparse.Namespace) -> None:
    topic = args.topic or "thing/product/+/osd"
    client_id = args.client_id or f"h30t-cloud-temp-{secrets.token_hex(4)}"
    print(f"[cloud-mqtt] subscribe mqtt{'s' if args.tls else ''}://{args.mqtt_host}:{args.mqtt_port} {topic}", flush=True)
    print(f"[cloud-mqtt] inject -> {args.viewer_url}", flush=True)
    while True:
        try:
            sock = mqtt_open(args)
            with sock:
                mqtt_send_connect(sock, client_id, args.username, args.password, args.keepalive_s)
                mqtt_send_subscribe(sock, topic)
                last_ping = time.monotonic()
                while True:
                    if time.monotonic() - last_ping > args.keepalive_s / 2:
                        sock.sendall(b"\xC0\x00")
                        last_ping = time.monotonic()
                    header, body = mqtt_read_packet(sock)
                    packet_type = header >> 4
                    if packet_type == 3:
                        mqtt_topic, payload_bytes, qos, packet_id = mqtt_parse_publish(header, body)
                        if qos == 1 and packet_id:
                            sock.sendall(b"\x40\x02" + packet_id.to_bytes(2, "big"))
                        try:
                            cloud_message = json.loads(payload_bytes.decode("utf-8"))
                            normalized = normalize_pilot2_properties(cloud_message)
                            normalized["source"] = "PILOT2_CLOUD_API"
                            normalized["transport_mode"] = "flighthub2_cloud_mqtt"
                            http_json("POST", args.viewer_url, payload=normalized, timeout_s=args.timeout_s)
                            print(
                                f"[cloud-mqtt] topic={mqtt_topic} seq={normalized.get('seq')} max={normalized.get('max_c')}",
                                flush=True,
                            )
                        except Exception as exc:
                            if args.verbose_ignored:
                                print(f"[cloud-mqtt] ignored message on {mqtt_topic}: {exc}", flush=True)
                    elif packet_type == 13:
                        continue
        except KeyboardInterrupt:
            return
        except Exception as exc:
            print(f"[cloud-mqtt] reconnecting: {safe_text(exc)}", flush=True)
            time.sleep(max(0.5, args.reconnect_ms / 1000.0))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Network relay for H30T global max temperature.")
    sub = parser.add_subparsers(dest="mode", required=True)

    server = sub.add_parser("server")
    server.add_argument("--host", default="0.0.0.0")
    server.add_argument("--port", type=int, default=8091)
    server.add_argument("--token", default="")
    server.add_argument("--output-dir", default="outputs/wireless/network_temperature")
    server.add_argument("--run-seconds", type=float, default=0.0)
    server.set_defaults(func=run_server)

    inject = sub.add_parser("inject")
    inject.add_argument("--relay-url", required=True)
    inject.add_argument("--viewer-url", default="http://127.0.0.1:8010/upload_h30t_global")
    inject.add_argument("--token", default="")
    inject.add_argument("--interval-ms", type=int, default=500)
    inject.add_argument("--timeout-s", type=float, default=3.0)
    inject.add_argument("--repeat", action="store_true")
    inject.add_argument("--run-seconds", type=float, default=0.0)
    inject.set_defaults(func=run_inject)

    simulate = sub.add_parser("simulate")
    simulate.add_argument("--relay-url", required=True)
    simulate.add_argument("--token", default="")
    simulate.add_argument("--base-c", type=float, default=41.0)
    simulate.add_argument("--step-c", type=float, default=0.7)
    simulate.add_argument("--step-count", type=int, default=10)
    simulate.add_argument("--interval-ms", type=int, default=1000)
    simulate.add_argument("--timeout-s", type=float, default=3.0)
    simulate.add_argument("--run-seconds", type=float, default=0.0)
    simulate.set_defaults(func=run_simulate)

    ntfy_inject = sub.add_parser("ntfy-inject")
    ntfy_inject.add_argument("--ntfy-url", required=True)
    ntfy_inject.add_argument("--viewer-url", default="http://127.0.0.1:8010/upload_h30t_global")
    ntfy_inject.add_argument("--timeout-s", type=float, default=3.0)
    ntfy_inject.add_argument("--connect-timeout-s", type=float, default=90.0)
    ntfy_inject.add_argument("--reconnect-ms", type=int, default=1000)
    ntfy_inject.set_defaults(func=run_ntfy_inject)

    cloud_mqtt = sub.add_parser("cloud-mqtt-inject")
    cloud_mqtt.add_argument("--mqtt-host", required=True)
    cloud_mqtt.add_argument("--mqtt-port", type=int, default=1883)
    cloud_mqtt.add_argument("--username", default="")
    cloud_mqtt.add_argument("--password", default="")
    cloud_mqtt.add_argument("--client-id", default="")
    cloud_mqtt.add_argument("--topic", default="thing/product/+/osd")
    cloud_mqtt.add_argument("--tls", action="store_true")
    cloud_mqtt.add_argument("--viewer-url", default="http://127.0.0.1:8010/upload_h30t_global")
    cloud_mqtt.add_argument("--timeout-s", type=float, default=3.0)
    cloud_mqtt.add_argument("--connect-timeout-s", type=float, default=10.0)
    cloud_mqtt.add_argument("--socket-timeout-s", type=float, default=30.0)
    cloud_mqtt.add_argument("--keepalive-s", type=int, default=30)
    cloud_mqtt.add_argument("--reconnect-ms", type=int, default=2000)
    cloud_mqtt.add_argument("--verbose-ignored", action="store_true")
    cloud_mqtt.set_defaults(func=run_cloud_mqtt_inject)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
