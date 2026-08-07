export type WhepSession = {
  stop: () => void;
  peerConnection: RTCPeerConnection;
};

// Plays a WebRTC-HTTP Egress Protocol stream. SDP exchange is proxied
// through /api/livestream/whep to sidestep CORS on FlightHub's SRS host.
export async function playWhep(
  whepUrl: string,
  videoEl: HTMLVideoElement,
  onError?: (err: Error) => void
): Promise<WhepSession> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const stream = new MediaStream();
  videoEl.srcObject = stream;
  pc.ontrack = (event) => {
    for (const track of event.streams[0].getTracks()) stream.addTrack(track);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      onError?.(new Error(`WebRTC connection ${pc.connectionState}`));
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const proxied = `/api/livestream/whep?url=${encodeURIComponent(whepUrl)}`;
  const res = await fetch(proxied, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp ?? "",
  });
  if (!res.ok) {
    pc.close();
    throw new Error(`WHEP signaling failed: ${res.status} ${await res.text()}`);
  }
  const answerSdp = await res.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return {
    peerConnection: pc,
    stop: () => {
      for (const track of stream.getTracks()) track.stop();
      videoEl.srcObject = null;
      pc.close();
    },
  };
}
