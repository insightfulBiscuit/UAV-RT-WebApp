import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Runtime registry mapping our device tiles to Akamai relay WHEP URLs.
 *
 * Each entry describes ONE stream. The `match` shape encodes which tile in
 * the Live view it applies to — either an aircraft (sn + camera_index +
 * lens) or a gateway (sn + camera_index + position). Wildcards ("any") let
 * a single entry cover many tiles; useful for the coworker's original M400
 * stream which was defined before we split tiles by lens.
 *
 * The config file lives at `server/config/akamai-streams.json`. Override
 * with AKAMAI_STREAMS_CONFIG if you want to point at a mounted file.
 */

export type AkamaiMatch = {
  aircraftSn?: string;
  gatewaySn?: string;
  cameraIndex?: string;
  lens?: string;
  position?: string;
};

export type AkamaiStreamConfig = {
  id: string;
  label: string;
  match: AkamaiMatch;
  whepUrl: string;
  mediamtxPath: string;
  source: string;
};

const DEFAULT_PATH = join(process.cwd(), "config", "akamai-streams.json");

function isConfigured(s: AkamaiStreamConfig): boolean {
  // A stream is "ready to play" only if the source URL doesn't still contain
  // a placeholder. The path can be registered ahead of time, but until real
  // creds land the endpoint should refuse rather than pretend.
  return !/CHANGEME_/.test(s.source);
}

function isWildcard(v: string | undefined): boolean {
  return !v || v.toLowerCase() === "any" || v === "*";
}

class AkamaiRegistry {
  private streams: AkamaiStreamConfig[] = [];
  private loadedFrom: string | null = null;
  private loadError: string | null = null;

  load(): void {
    const path = process.env.AKAMAI_STREAMS_CONFIG || DEFAULT_PATH;
    if (!existsSync(path)) {
      this.loadError = `Akamai streams config not found at ${path}`;
      this.streams = [];
      return;
    }
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      const list: unknown = Array.isArray(parsed) ? parsed : parsed?.streams;
      if (!Array.isArray(list)) throw new Error("config missing `streams` array");
      this.streams = list as AkamaiStreamConfig[];
      this.loadedFrom = path;
      this.loadError = null;
    } catch (err) {
      this.loadError = `Failed to load ${path}: ${(err as Error).message}`;
      this.streams = [];
    }
  }

  status() {
    return {
      loadedFrom: this.loadedFrom,
      loadError: this.loadError,
      totalStreams: this.streams.length,
      readyStreams: this.streams.filter(isConfigured).length,
    };
  }

  list(): Array<AkamaiStreamConfig & { ready: boolean }> {
    return this.streams.map((s) => ({ ...s, ready: isConfigured(s) }));
  }

  /**
   * Find the best Akamai match for a live-view tile. Order:
   *   1. Exact match on all provided fields.
   *   2. Then relax `lens` / `position`.
   *   3. Then relax `cameraIndex`.
   *   4. Then any wildcard/legacy stream.
   */
  findForTile(query: AkamaiMatch): (AkamaiStreamConfig & { ready: boolean }) | null {
    const specificity = (s: AkamaiStreamConfig): number => {
      let score = 0;
      if (!isWildcard(s.match.aircraftSn) && s.match.aircraftSn === query.aircraftSn) score += 8;
      if (!isWildcard(s.match.gatewaySn) && s.match.gatewaySn === query.gatewaySn) score += 8;
      if (!isWildcard(s.match.cameraIndex) && s.match.cameraIndex === query.cameraIndex) score += 4;
      if (!isWildcard(s.match.lens) && s.match.lens === query.lens) score += 2;
      if (!isWildcard(s.match.position) && s.match.position === query.position) score += 2;
      return score;
    };

    const eligible = this.streams.filter((s) => {
      // Reject if a non-wildcard field disagrees.
      if (!isWildcard(s.match.aircraftSn) && query.aircraftSn && s.match.aircraftSn !== query.aircraftSn) {
        return false;
      }
      if (!isWildcard(s.match.gatewaySn) && query.gatewaySn && s.match.gatewaySn !== query.gatewaySn) {
        return false;
      }
      if (!isWildcard(s.match.cameraIndex) && query.cameraIndex && s.match.cameraIndex !== query.cameraIndex) {
        return false;
      }
      if (!isWildcard(s.match.lens) && query.lens && s.match.lens !== query.lens) return false;
      if (!isWildcard(s.match.position) && query.position && s.match.position !== query.position) return false;
      return true;
    });

    if (eligible.length === 0) return null;
    eligible.sort((a, b) => specificity(b) - specificity(a));
    const chosen = eligible[0];
    return { ...chosen, ready: isConfigured(chosen) };
  }
}

export const akamaiRegistry = new AkamaiRegistry();
akamaiRegistry.load();
