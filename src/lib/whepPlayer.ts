/**
 * Minimal WHEP (WebRTC-HTTP Egress Protocol) player.
 *
 * A single `POST offer.sdp → answer.sdp` handshake against a MediaMTX
 * WHEP endpoint. Standard WebRTC receive-only, no proprietary SDKs.
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

export async function playWhep(
  whepUrl: string,
  containerEl: HTMLElement,
  onError?: (err: Error) => void,
): Promise<WhepSession> {
  LOG("open", whepUrl);
  const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });

  // We only ever receive from the drone; never publish.
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

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

  pc.ontrack = (event) => {
    LOG("ontrack", event.track.kind);
    if (event.streams[0] && video.srcObject !== event.streams[0]) {
      video.srcObject = event.streams[0];
    }
  };

  pc.oniceconnectionstatechange = () => {
    LOG("ice", pc.iceConnectionState);
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      onError?.(new Error(`WebRTC ICE ${pc.iceConnectionState}`));
    }
  };

  let resourceUrl: string | null = null;

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
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
      // Fallback: don't wait more than 2 seconds
      setTimeout(resolve, 2000);
    });

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
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`WHEP ${res.status}: ${body.slice(0, 200)}`);
    }
    // MediaMTX returns the answer's resource URL in `Location` for DELETE on stop.
    const loc = res.headers.get("Location");
    if (loc) resourceUrl = new URL(loc, whepUrl).toString();

    const answerSdp = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    LOG("answer applied");
  } catch (err) {
    LOG("open failed", err);
    pc.close();
    containerEl.innerHTML = "";
    throw err;
  }

  return {
    stop: () => {
      LOG("stop");
      if (resourceUrl) {
        // Best-effort DELETE per WHEP spec so MediaMTX can free the session.
        void fetch(resourceUrl, { method: "DELETE" }).catch(() => {});
      }
      try { pc.close(); } catch { /* ignore */ }
      containerEl.innerHTML = "";
    },
  };
}
