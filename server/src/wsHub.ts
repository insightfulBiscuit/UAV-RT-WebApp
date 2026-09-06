import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";

/**
 * Small pub/sub over WebSocket. Clients connect to /ws/thermal and receive
 * anchor + calibration events pushed from the server.
 */

type ChannelName = "thermal";

class WsHub {
  private wss: WebSocketServer | null = null;
  private clients = new Map<ChannelName, Set<WebSocket>>();

  attach(server: HttpServer): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (socket, req) => {
      const url = new URL(req.url ?? "/ws", "http://localhost");
      const channel = (url.searchParams.get("channel") as ChannelName) || "thermal";
      let set = this.clients.get(channel);
      if (!set) {
        set = new Set();
        this.clients.set(channel, set);
      }
      set.add(socket);
      socket.on("close", () => set!.delete(socket));
      socket.on("error", () => set!.delete(socket));
    });
  }

  broadcast(channel: ChannelName, payload: unknown): void {
    const set = this.clients.get(channel);
    if (!set || set.size === 0) return;
    const msg = JSON.stringify(payload);
    for (const s of set) {
      if (s.readyState === s.OPEN) s.send(msg);
    }
  }

  clientCount(channel: ChannelName): number {
    return this.clients.get(channel)?.size ?? 0;
  }
}

export const wsHub = new WsHub();
