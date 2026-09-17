import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { FirestoreChannelSync } from "./firestore-sync";
import { firestore } from "./firebase";

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
const localChannels = new Map<string, Map<string, DeviceSession>>();
// Firestore sync managers: channelCode -> FirestoreChannelSync
const firestoreSyncs = new Map<string, FirestoreChannelSync>();
// Channel revisions to prevent out-of-order race conditions
const channelRevisions = new Map<string, number>();

// Socket to session mapping
const socketSessions = new Map<WebSocket, DeviceSession>();

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const totalChannels = localChannels.size;
    let totalDevices = 0;
    for (const room of localChannels.values()) {
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
        uptime: Math.floor(process.uptime()),
        totalChannels,
        totalDevices,
        firestoreSyncEnabled: !!firestore,
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

function getChannelRevision(code: string): number {
  return channelRevisions.get(code) || 0;
}

function incrementChannelRevision(code: string): number {
  const rev = (channelRevisions.get(code) || 0) + 1;
  channelRevisions.set(code, rev);
  return rev;
}

function getChannelMembersList(code: string): DeviceInfo[] {
  const room = localChannels.get(code);
  if (!room) return [];

  const allDevicesMap = new Map<string, DeviceInfo>();
  
  // 1. Cross-instance members from Firestore (if configured)
  const sync = firestoreSyncs.get(code);
  if (sync) {
    const syncDevices = sync.getAllMembers();
    for (const d of syncDevices) {
      allDevicesMap.set(d.id, d);
    }
  }

  // 2. In-memory local sessions are authoritative and override any stale remote record
  for (const p of room.values()) {
    if (p.deviceId) {
      allDevicesMap.set(p.deviceId, {
        id: p.deviceId,
        name: p.deviceName,
        platform: p.platform,
        joinedAt: p.joinedAt,
      });
    }
  }

  return Array.from(allDevicesMap.values());
}

function broadcastMembers(code: string, incrementRev = true) {
  if (!localChannels.has(code)) return;
  const room = localChannels.get(code)!;
  
  const revision = incrementRev ? incrementChannelRevision(code) : getChannelRevision(code);
  const devices = getChannelMembersList(code);

  console.log(`[CHANNEL] revision=${revision} members=${devices.length} code=${code} devices=${devices.map(d => d.id).join(",")}`);

  for (const session of room.values()) {
    const peers = devices.filter(d => d.id !== session.deviceId);
    sendJson(session.ws, {
      type: "members",
      channelCode: code,
      revision,
      devices: peers,
    });
  }
}

function getOrCreateFirestoreSync(code: string): FirestoreChannelSync | null {
  if (!firestore) return null;
  if (!firestoreSyncs.has(code)) {
    const sync = new FirestoreChannelSync(
      code,
      () => {
        broadcastMembers(code, true);
      },
      () => {
        broadcastMembers(code, true);
      },
      (msg) => {
        const room = localChannels.get(code);
        if (room && msg.targetDeviceId) {
          const targetSession = room.get(msg.targetDeviceId);
          if (targetSession) {
            sendJson(targetSession.ws, {
              ...msg.payload,
              type: msg.type,
              channelCode: code,
              fromDeviceId: msg.fromDeviceId,
              targetDeviceId: msg.targetDeviceId,
            });
          }
        }
      }
    );
    sync.start();
    firestoreSyncs.set(code, sync);
  }
  return firestoreSyncs.get(code)!;
}

function removeSessionFromChannel(session: DeviceSession) {
  const { channelCode, deviceId } = session;
  if (!channelCode) return;

  const room = localChannels.get(channelCode);
  if (room) {
    room.delete(deviceId);
    console.log(`[CHANNEL] leave code=${channelCode} device=${deviceId || "anon"} remaining=${room.size}`);

    const sync = firestoreSyncs.get(channelCode);
    if (sync && deviceId) {
      sync.unregisterLocalDevice(deviceId);
    }

    if (room.size === 0) {
      localChannels.delete(channelCode);
      channelRevisions.delete(channelCode);
      if (sync) {
        sync.stop();
        firestoreSyncs.delete(channelCode);
      }
      console.log(`[CHANNEL] Cleaned up empty channel ${channelCode}`);
    } else {
      broadcastMembers(channelCode, true);
    }
  }

  session.channelCode = "";
}

async function forwardSignalingMessage(session: DeviceSession, msg: any, type: string) {
  const { targetDeviceId, fromDeviceId, sdp, candidate } = msg;
  const code = session.channelCode;
  if (!code || !localChannels.has(code)) {
    sendJson(session.ws, { type: "error", message: "Not in a channel." });
    return;
  }

  const room = localChannels.get(code)!;
  const targetSession = room.get(targetDeviceId);
  const payload = sdp ? { sdp } : candidate ? { candidate } : {};

  if (targetSession) {
    sendJson(targetSession.ws, {
      ...payload,
      type,
      channelCode: code,
      fromDeviceId: fromDeviceId || session.deviceId,
      targetDeviceId,
    });
  } else {
    const sync = firestoreSyncs.get(code);
    if (sync) {
      const sent = await sync.sendMessage(targetDeviceId, fromDeviceId || session.deviceId, type, payload);
      if (!sent) {
        console.warn(`[WARN] Failed to route ${type} to ${targetDeviceId}`);
      }
    }
  }
}

wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  const clientIp = req.socket.remoteAddress || "unknown";
  console.log(`[WS] connected remote=${clientIp}`);

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

  ws.on("message", async (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type } = msg;

      // Keepalive activity
      session.isAlive = true;
      session.lastPing = Date.now();

      switch (type) {
        case "join": {
          const rawCode = msg.channelCode;
          const code = normalizeChannel(rawCode);
          const rawDeviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
          const rawDeviceName = typeof msg.deviceName === "string" ? msg.deviceName.trim().slice(0, 50) : "Device";
          const platform = typeof msg.platform === "string" ? msg.platform : "browser";

          if (!code || code.length < 3) {
            sendJson(ws, { type: "join_error", code: "INVALID_CHANNEL", message: "Invalid channel code (must be 3-12 alphanumeric characters)." });
            return;
          }

          if (!rawDeviceId) {
            sendJson(ws, { type: "join_error", code: "MISSING_DEVICE_ID", message: "Missing required deviceId." });
            return;
          }

          // If session was previously in a different channel, leave it first
          if (session.channelCode && session.channelCode !== code) {
            removeSessionFromChannel(session);
          }

          session.deviceId = rawDeviceId;
          session.deviceName = rawDeviceName || "Device";
          session.platform = platform;
          session.channelCode = code;
          session.joinedAt = Date.now();
          session.isAlive = true;

          if (!localChannels.has(code)) {
            localChannels.set(code, new Map());
          }
          const room = localChannels.get(code)!;
          
          // If the same device reconnected from another socket, close old socket cleanly
          const existing = room.get(rawDeviceId);
          if (existing && existing.ws !== ws) {
            console.log(`[WS] Replacing existing socket for device ${rawDeviceId}`);
            sendJson(existing.ws, { type: "error", message: "Device reconnected from a new session." });
            socketSessions.delete(existing.ws);
            existing.ws.close(1000, "Reconnected");
          }

          room.set(rawDeviceId, session);
          const revision = incrementChannelRevision(code);

          console.log(`[WS] register device=${session.deviceId} name=${session.deviceName} platform=${session.platform}`);
          console.log(`[CHANNEL] join code=${code} device=${session.deviceId} revision=${revision}`);

          try {
            const sync = getOrCreateFirestoreSync(code);
            if (sync) {
              await sync.registerLocalDevice({
                id: session.deviceId,
                name: session.deviceName,
                platform: session.platform,
                joinedAt: session.joinedAt
              });
            }
          } catch (syncErr) {
            console.warn(`[FirestoreSync] Failed to register device on join:`, syncErr);
          }

          // Send explicit JOIN_ACK with current members to joining client
          const allMembers = getChannelMembersList(code);
          const peers = allMembers.filter(d => d.id !== session.deviceId);
          
          sendJson(ws, {
            type: "join_ack",
            channelCode: code,
            deviceId: session.deviceId,
            revision,
            members: peers,
          });
          
          // Broadcast updated member snapshot to ALL members
          broadcastMembers(code, false);
          break;
        }

        case "create_channel": {
          const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
          let code = "";
          let attempts = 0;
          do {
            code = "";
            for (let i = 0; i < 6; i++) {
              code += alphabet[Math.floor(Math.random() * alphabet.length)];
            }
            attempts++;
          } while (localChannels.has(code) && attempts < 100);

          sendJson(ws, { type: "channel_created", channelCode: code });
          break;
        }

        case "leave": {
          removeSessionFromChannel(session);
          sendJson(ws, { type: "left" });
          break;
        }

        case "rename": {
          const newName = typeof msg.deviceName === "string" ? msg.deviceName.trim().slice(0, 50) : "";
          if (newName && session.deviceId) {
            session.deviceName = newName;
            const code = session.channelCode;
            console.log(`[WS] rename device=${session.deviceId} newName=${newName}`);
            
            try {
              const sync = firestoreSyncs.get(code);
              if (sync) {
                await sync.registerLocalDevice({
                  id: session.deviceId,
                  name: session.deviceName,
                  platform: session.platform,
                  joinedAt: session.joinedAt
                });
              }
            } catch (syncErr) {
              console.warn(`[FirestoreSync] Failed to register device on rename:`, syncErr);
            }
            if (code) {
              broadcastMembers(code, true);
            }
          }
          break;
        }

        case "offer":
        case "answer":
        case "ice-candidate": {
          await forwardSignalingMessage(session, msg, type);
          break;
        }

        case "ping": {
          session.isAlive = true;
          session.lastPing = Date.now();
          sendJson(ws, { type: "pong", timestamp: Date.now() });
          break;
        }
      }
    } catch (err) {
      console.error("[ERROR] Failed to process incoming message:", err);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] disconnected device=${session.deviceId || "unregistered"} code=${code} reason=${reason.toString() || "none"}`);
    removeSessionFromChannel(session);
    socketSessions.delete(ws);
  });

  ws.on("error", (err: Error) => {
    console.warn(`[WS ERROR] ${session.deviceId || "unregistered"}:`, err.message);
  });
});

// Periodic heartbeat watchdog to prune dead/stale connections (every 15s)
const heartbeatInterval = setInterval(() => {
  for (const [ws, session] of socketSessions.entries()) {
    if (!session.isAlive) {
      console.log(`[TIMEOUT] Terminating stale socket for device=${session.deviceId || "unregistered"}`);
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

// Graceful shutdown on SIGTERM / SIGINT
function gracefulShutdown(signal: string) {
  console.log(`\n[SHUTDOWN] Received ${signal}. Closing signaling server cleanly...`);
  clearInterval(heartbeatInterval);

  for (const [ws, session] of socketSessions.entries()) {
    try {
      sendJson(ws, { type: "shutdown", message: "Server shutting down." });
      ws.close(1001, "Server shutdown");
    } catch {}
  }
  socketSessions.clear();
  localChannels.clear();

  for (const sync of firestoreSyncs.values()) {
    sync.stop();
  }
  firestoreSyncs.clear();

  server.close(() => {
    console.log("[SHUTDOWN] HTTP/WS server closed successfully.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[SHUTDOWN] Force exiting after timeout.");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`⚡ SlideDrop WebSocket Signaling Server running`);
  console.log(`📡 Listening on: ws://${HOST}:${PORT}`);
  console.log(`=======================================================`);
});
