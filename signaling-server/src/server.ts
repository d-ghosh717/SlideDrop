import { WebSocketServer, WebSocket } from "ws";
import http from "http";

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";

interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  joinedAt: number;
}

interface DeviceSession {
  ws: WebSocket;
  deviceId: string;
  deviceName: string;
  platform: string;
  channelCode: string;
  joinedAt: number;
  lastPing: number;
  isAlive: boolean;
}

// In-memory channel registry: channelCode -> Map<deviceId, DeviceSession>
const channels = new Map<string, Map<string, DeviceSession>>();
// Socket to session mapping
const socketSessions = new Map<WebSocket, DeviceSession>();

const server = http.createServer((req, res) => {
  // Simple health check and status endpoint
  if (req.url === "/health" || req.url === "/") {
    const totalChannels = channels.size;
    let totalDevices = 0;
    for (const room of channels.values()) {
      totalDevices += room.size;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "SlideDrop WebSocket Signaling Server",
        uptime: process.uptime(),
        totalChannels,
        totalDevices,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ server });

function sendJson(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function normalizeChannel(code: unknown): string {
  if (typeof code !== "string") return "";
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function removeSessionFromChannel(session: DeviceSession) {
  const { channelCode, deviceId } = session;
  if (!channelCode) return;

  const room = channels.get(channelCode);
  if (room) {
    room.delete(deviceId);
    console.log(`[Leave] Device ${session.deviceName} (${deviceId}) left channel ${channelCode} (${room.size} remaining)`);

    // Notify remaining peers in the same channel
    for (const [otherId, peer] of room.entries()) {
      if (otherId !== deviceId) {
        sendJson(peer.ws, {
          type: "device-left",
          channelCode,
          deviceId,
        });
      }
    }

    // Clean up empty channels
    if (room.size === 0) {
      channels.delete(channelCode);
      console.log(`[Clean] Channel ${channelCode} is empty and was removed.`);
    }
  }

  session.channelCode = "";
}

wss.on("connection", (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[Connect] New client connected from ${clientIp}`);

  const session: DeviceSession = {
    ws,
    deviceId: "",
    deviceName: "Device",
    platform: "browser",
    channelCode: "",
    joinedAt: Date.now(),
    lastPing: Date.now(),
    isAlive: true,
  };

  socketSessions.set(ws, session);

  ws.on("pong", () => {
    session.isAlive = true;
    session.lastPing = Date.now();
  });

  ws.on("message", (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type } = msg;

      switch (type) {
        // 1. Join Channel
        case "join": {
          const rawCode = msg.channelCode;
          const code = normalizeChannel(rawCode);
          const rawDeviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
          const rawDeviceName = typeof msg.deviceName === "string" ? msg.deviceName.trim().slice(0, 50) : "Device";
          const platform = typeof msg.platform === "string" ? msg.platform : "browser";

          if (!code || code.length < 3) {
            sendJson(ws, { type: "error", message: "Invalid channel code (must be 3-12 alphanumeric characters)." });
            return;
          }

          if (!rawDeviceId) {
            sendJson(ws, { type: "error", message: "Missing required deviceId." });
            return;
          }

          // If already in a channel, leave it first
          if (session.channelCode && session.channelCode !== code) {
            removeSessionFromChannel(session);
          }

          session.deviceId = rawDeviceId;
          session.deviceName = rawDeviceName || "Device";
          session.platform = platform;
          session.channelCode = code;
          session.joinedAt = Date.now();
          session.isAlive = true;

          if (!channels.has(code)) {
            channels.set(code, new Map());
          }

          const room = channels.get(code)!;
          // If socket for same device ID was already in room, clean it up
          const existing = room.get(rawDeviceId);
          if (existing && existing.ws !== ws) {
            sendJson(existing.ws, { type: "error", message: "Device reconnected from another session." });
            existing.ws.close();
          }

          room.set(rawDeviceId, session);

          console.log(`[Join] Device "${session.deviceName}" (${session.deviceId}) joined channel "${code}" (${room.size} devices)`);

          // Collect current members in room (excluding self)
          const membersList: DeviceInfo[] = [];
          for (const [otherId, peer] of room.entries()) {
            if (otherId !== session.deviceId) {
              membersList.push({
                id: peer.deviceId,
                name: peer.deviceName,
                platform: peer.platform,
                joinedAt: peer.joinedAt,
              });
            }
          }

          // Acknowledge to joining device with list of existing peers
          sendJson(ws, {
            type: "joined",
            channelCode: code,
            self: {
              id: session.deviceId,
              name: session.deviceName,
              platform: session.platform,
              joinedAt: session.joinedAt,
            },
            devices: membersList,
          });

          // Broadcast to existing peers that a new device joined
          const newMemberInfo: DeviceInfo = {
            id: session.deviceId,
            name: session.deviceName,
            platform: session.platform,
            joinedAt: session.joinedAt,
          };

          for (const [otherId, peer] of room.entries()) {
            if (otherId !== session.deviceId) {
              sendJson(peer.ws, {
                type: "device-joined",
                channelCode: code,
                device: newMemberInfo,
              });
            }
          }
          break;
        }

        // 2. Leave Channel
        case "leave": {
          removeSessionFromChannel(session);
          sendJson(ws, { type: "left" });
          break;
        }

        // 3. Rename Device
        case "rename": {
          const newName = typeof msg.deviceName === "string" ? msg.deviceName.trim().slice(0, 50) : "";
          if (newName) {
            session.deviceName = newName;
            const code = session.channelCode;
            if (code && channels.has(code)) {
              const room = channels.get(code)!;
              for (const [otherId, peer] of room.entries()) {
                if (otherId !== session.deviceId) {
                  sendJson(peer.ws, {
                    type: "device-updated",
                    channelCode: code,
                    device: {
                      id: session.deviceId,
                      name: session.deviceName,
                      platform: session.platform,
                      joinedAt: session.joinedAt,
                    },
                  });
                }
              }
            }
          }
          break;
        }

        // 4. WebRTC Signaling: Offer forwarding
        case "offer": {
          const { targetDeviceId, fromDeviceId, sdp } = msg;
          const code = session.channelCode;
          if (!code || !channels.has(code)) {
            sendJson(ws, { type: "error", message: "Not in a channel." });
            return;
          }

          const room = channels.get(code)!;
          const targetSession = room.get(targetDeviceId);
          if (targetSession) {
            sendJson(targetSession.ws, {
              type: "offer",
              channelCode: code,
              fromDeviceId: fromDeviceId || session.deviceId,
              targetDeviceId,
              sdp,
            });
          }
          break;
        }

        // 5. WebRTC Signaling: Answer forwarding
        case "answer": {
          const { targetDeviceId, fromDeviceId, sdp } = msg;
          const code = session.channelCode;
          if (!code || !channels.has(code)) {
            sendJson(ws, { type: "error", message: "Not in a channel." });
            return;
          }

          const room = channels.get(code)!;
          const targetSession = room.get(targetDeviceId);
          if (targetSession) {
            sendJson(targetSession.ws, {
              type: "answer",
              channelCode: code,
              fromDeviceId: fromDeviceId || session.deviceId,
              targetDeviceId,
              sdp,
            });
          }
          break;
        }

        // 6. WebRTC Signaling: ICE Candidate forwarding
        case "ice-candidate": {
          const { targetDeviceId, fromDeviceId, candidate } = msg;
          const code = session.channelCode;
          if (!code || !channels.has(code)) return;

          const room = channels.get(code)!;
          const targetSession = room.get(targetDeviceId);
          if (targetSession) {
            sendJson(targetSession.ws, {
              type: "ice-candidate",
              channelCode: code,
              fromDeviceId: fromDeviceId || session.deviceId,
              targetDeviceId,
              candidate,
            });
          }
          break;
        }

        // 7. Ping / Heartbeat
        case "ping": {
          session.isAlive = true;
          session.lastPing = Date.now();
          sendJson(ws, { type: "pong", timestamp: Date.now() });
          break;
        }

        default:
          console.warn(`[Warn] Unknown message type "${type}" from ${session.deviceId}`);
      }
    } catch (err) {
      console.error("[Error] Failed to process incoming message:", err);
    }
  });

  ws.on("close", () => {
    console.log(`[Disconnect] Client ${session.deviceName} (${session.deviceId || "unregistered"}) disconnected`);
    removeSessionFromChannel(session);
    socketSessions.delete(ws);
  });

  ws.on("error", (err) => {
    console.warn(`[Socket Error] ${session.deviceId}:`, err.message);
  });
});

// Periodic Heartbeat check: detect and clean up dead sockets every 15 seconds
const heartbeatInterval = setInterval(() => {
  for (const [ws, session] of socketSessions.entries()) {
    if (!session.isAlive) {
      console.log(`[Timeout] Terminating inactive socket for device ${session.deviceId}`);
      removeSessionFromChannel(session);
      socketSessions.delete(ws);
      ws.terminate();
      continue;
    }

    session.isAlive = false;
    ws.ping();
  }
}, 15000);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`⚡ SlideDrop WebSocket Signaling Server running`);
  console.log(`📡 Listening on: ws://${HOST}:${PORT}`);
  console.log(`🌐 Health check: http://${HOST}:${PORT}/health`);
  console.log(`=======================================================`);
});
