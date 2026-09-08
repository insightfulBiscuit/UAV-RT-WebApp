/**
 * WHEP (WebRTC-HTTP Egress Protocol) player with auto-reconnect.
 *
 * A single WHEP handshake is a `POST offer.sdp → answer.sdp` against a
 * MediaMTX WHEP endpoint. Standard WebRTC receive-only, no proprietary SDKs.
 *
 * Auto-reconnect exists because FH2 Share rotates its publisher pool every
 * 10-15 seconds — each rotation has a 1-3 second gap where MediaMTX has no
 * source, WebRTC sees no packets, and the peer drops. `restartIce()` alone
 * doesn't help there because MediaMTX has already terminated the session on
 * its side. We watch for prolonged silence and rebuild the WHEP session
 * fully (fresh POST) whenever the current one goes cold.
 *
 * Usage:
 *   const session = await playWhep(whepUrl, containerEl, (err) => …);
 *   session.stop();
 */

export type WhepSession = {
  stop: () => void;
};

const LOG = (m: string, ...rest: unknown[]) => console.log(`[whep] ${m}`, ...rest);

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

// How long we tolerate `disconnected` / a stalled video before rebuilding
// the WHEP session. Tuned for FH2 Share's ~1-3 s publisher-rotation gap;
// keeps latency down without triggering on brief hiccups.
const RECONNECT_AFTER_MS = 3000;
// Small backoff between full session rebuilds to avoid hot-looping if the
// upstream is genuinely down.
const RECONNECT_BACKOFF_MS = 750;

export async function playWhep(
  whepUrl: string,
  containerEl: HTMLElement,
  onError?: (err: Error) => void,
): Promise<WhepSession> {
  // The video element is mounted ONCE and re-used across reconnects so the
  // parent DOM/overlays don't flicker.
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.width = "100%";
  video.style.height = "100%";
  video.style.objectFit = "contain";
  video.style.background = "#000";
  containerEl.innerHTML = "";
  containerEl.appendChild(video);

  let stopped = false;
  let currentPc: RTCPeerConnection | null = null;
  let currentResourceUrl: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = (why: string) => {
    if (stopped) return;
    if (reconnectTimer) return;
    LOG(`reconnect scheduled (${why})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openOnce().catch((e) => LOG("reconnect failed", e));
    }, RECONNECT_BACKOFF_MS);
  };

  const teardownCurrent = () => {
    if (currentResourceUrl) {
      void fetch(currentResourceUrl, { method: "DELETE" }).catch(() => {});
      currentResourceUrl = null;
    }
    if (currentPc) {
      try { currentPc.close(); } catch { /* ignore */ }
      currentPc = null;
    }
  };

  const openOnce = async (): Promise<void> => {
    if (stopped) return;
    teardownCurrent();
    LOG("open", whepUrl);
    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
    currentPc = pc;

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (event) => {
      LOG("ontrack", event.track.kind);
      if (event.streams[0] && video.srcObject !== event.streams[0]) {
        video.srcObject = event.streams[0];
      }
    };

    let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
    const clearDisconnectedTimer = () => {
      if (disconnectedTimer) { clearTimeout(disconnectedTimer); disconnectedTimer = null; }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc !== currentPc) return;
      LOG("ice", pc.iceConnectionState);
      switch (pc.iceConnectionState) {
        case "connected":
        case "completed":
          clearDisconnectedTimer();
          break;
        case "disconnected":
          clearDisconnectedTimer();
          // Give it a beat; if it doesn't recover, rebuild the whole session.
          // MediaMTX terminates its WHEP peer on upstream loss, so
          // restartIce() alone can't bring it back — a fresh POST is needed.
          disconnectedTimer = setTimeout(() => {
            if (pc === currentPc && pc.iceConnectionState === "disconnected") {
              LOG("disconnected, rebuilding session");
              scheduleReconnect("ice-disconnected");
            }
          }, RECONNECT_AFTER_MS);
          break;
        case "failed":
          clearDisconnectedTimer();
          scheduleReconnect("ice-failed");
          break;
        default:
          break;
      }
    };

    try {
      const offer = await pc.createOffer();
      if (pc !== currentPc || stopped) return;
      await pc.setLocalDescription(offer);
      if (pc !== currentPc || stopped) return;

      // Wait for ICE gathering to finish so the offer contains candidates.
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const check = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", check);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", check);
        setTimeout(resolve, 2000);
      });
      if (pc !== currentPc || stopped) return;

      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) throw new Error("No local SDP after setLocalDescription");

      LOG("POST offer");
      const res = await fetch(whepUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
          Accept: "application/sdp",
        },
        body: localSdp,
      });
      if (pc !== currentPc || stopped) return;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // MediaMTX returns 404 when the source path has no publisher live —
        // that's exactly the FH2-Share hand-off gap. Retry on backoff.
        LOG(`WHEP ${res.status}: ${body.slice(0, 200)}`);
        scheduleReconnect(`http-${res.status}`);
        return;
      }
      const loc = res.headers.get("Location");
      if (loc) currentResourceUrl = new URL(loc, whepUrl).toString();

      const answerSdp = await res.text();
      if (pc !== currentPc || stopped) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      LOG("answer applied");
    } catch (err) {
      LOG("open failed", err);
      // Distinguish once-and-done errors from transient ones. WHEP handshake
      // failure means MediaMTX is up but couldn't answer — worth another try.
      if (!stopped) scheduleReconnect("open-failed");
      // Only surface to the caller if this is the very first attempt AND we
      // couldn't schedule a reconnect (i.e. stopped mid-flight).
      if (stopped) onError?.(err as Error);
    }
  };

  await openOnce();

  return {
    stop: () => {
      LOG("stop");
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      teardownCurrent();
      containerEl.innerHTML = "";
    },
  };
}
