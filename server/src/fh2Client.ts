import { randomUUID } from "node:crypto";

export type Fh2Config = {
  baseUrl: string;
  userToken: string;
  projectUuid: string;
  language: string;
};

export type Fh2AuthConfig = Omit<Fh2Config, "projectUuid"> & { projectUuid?: string };

export function loadFh2AuthConfig(): Fh2AuthConfig {
  const baseUrl = process.env.FH2_BASE_URL;
  const userToken = process.env.FH2_USER_TOKEN;
  if (!baseUrl || !userToken) {
    throw new Error(
      "Missing FlightHub 2 auth. Set FH2_BASE_URL and FH2_USER_TOKEN in server/.env"
    );
  }
  const normalized = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return {
    baseUrl: normalized.replace(/\/$/, ""),
    userToken,
    projectUuid: process.env.FH2_PROJECT_UUID || undefined,
    language: process.env.FH2_LANGUAGE ?? "en",
  };
}

export function requireProjectConfig(cfg: Fh2AuthConfig): Fh2Config {
  if (!cfg.projectUuid) {
    throw new Fh2Error(400, -1, "FH2_PROJECT_UUID not set. Call GET /api/projects to list your projects, then set it in server/.env.");
  }
  return cfg as Fh2Config;
}

export type Fh2Envelope<T> = { code: number; message: string; data: T };

export class Fh2Error extends Error {
  constructor(public status: number, public code: number, message: string) {
    super(message);
  }
}

export async function fh2Post<T>(
  cfg: Fh2AuthConfig,
  path: string,
  body: unknown
): Promise<T> {
  const url = `${cfg.baseUrl}/openapi/v0.1${path}`;
  const headers: Record<string, string> = {
    "X-User-Token": cfg.userToken,
    "X-Request-Id": randomUUID(),
    "X-Language": cfg.language,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (cfg.projectUuid) headers["X-Project-Uuid"] = cfg.projectUuid;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    throw new Fh2Error(res.status, -1, `FlightHub HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let parsed: Fh2Envelope<T>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Fh2Error(res.status, -1, `FlightHub non-JSON response: ${text.slice(0, 300)}`);
  }
  if (parsed.code !== 0) {
    throw new Fh2Error(res.status, parsed.code, parsed.message || "FlightHub error");
  }
  return parsed.data;
}

export async function fh2Get<T>(
  cfg: Fh2AuthConfig,
  path: string,
  query?: Record<string, string | number | undefined | (string | number)[]>
): Promise<T> {
  const url = new URL(`${cfg.baseUrl}/openapi/v0.1${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const headers: Record<string, string> = {
    "X-User-Token": cfg.userToken,
    "X-Request-Id": randomUUID(),
    "X-Language": cfg.language,
    Accept: "application/json",
  };
  if (cfg.projectUuid) headers["X-Project-Uuid"] = cfg.projectUuid;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Fh2Error(res.status, -1, `FlightHub HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let body: Fh2Envelope<T>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Fh2Error(res.status, -1, `FlightHub non-JSON response: ${text.slice(0, 300)}`);
  }
  if (body.code !== 0) {
    throw new Fh2Error(res.status, body.code, body.message || "FlightHub error");
  }
  return body.data;
}
