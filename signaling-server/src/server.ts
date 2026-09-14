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
        uptime: process.uptime(),
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

function getOrCreateFirestoreSync(code: string): FirestoreChannelSync | null {
  if (!firestore) return null;
  if (!firestoreSyncs.has(code)) {
    const sync = new FirestoreChannelSync(
      code,
      (member) => {
        // onMemberAdded
        const room = localChannels.get(code);
        if (room) {
          for (const [id, session] of room.entries()) {
            if (id !== member.id) {
              sendJson(session.ws, {
                type: "device-joined",
                channelCode: code,
                device: member,
              });
            }
          }
        }
      },
      (deviceId) => {
        // onMemberRemoved
        const room = localChannels.get(code);
        if (room) {
          for (const [id, session] of room.entries()) {
            if (id !== deviceId) {
              sendJson(session.ws, {
                type: "device-left",
                channelCode: code,
                deviceId,
              });
            }
          }
        }
      },
      (msg) => {
        // onMessage
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
    console.log(`[WS] disconnect ${deviceId}`);

    const sync = firestoreSyncs.get(channelCode);
    if (sync) {
      sync.unregisterLocalDevice(deviceId);
    } else {
      // Notify remaining local peers
      for (const [otherId, peer] of room.entries()) {
        if (otherId !== deviceId) {
          sendJson(peer.ws, {
            type: "device-left",
            channelCode,
            deviceId,
          });
        }
      }
    }

    // Clean up empty channels
    if (room.size === 0) {
      localChannels.delete(channelCode);
      if (sync) {
        sync.stop();
        firestoreSyncs.delete(channelCode);
      }
      console.log(`[Clean] Channel ${channelCode} is empty and was removed.`);
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
    // Fast path: target is connected to the same instance
    sendJson(targetSession.ws, {
      ...payload,
      type,
      channelCode: code,
      fromDeviceId: fromDeviceId || session.deviceId,
      targetDeviceId,
    });
  } else {
    // Try Firestore pubsub
    const sync = firestoreSyncs.get(code);
    if (sync) {
      const sent = await sync.sendMessage(targetDeviceId, fromDeviceId || session.deviceId, type, payload);
      if (!sent) {
        console.warn(`[Warn] Failed to route ${type} to ${targetDeviceId}`);
      }
    }
  }
}

wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] connected ${clientIp}`);

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

      switch (type) {
        case "join": {
          const rawCode = msg.channelCode;
          const code = normalizeChannel(rawCode);
          const rawDeviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
          const rawDeviceName = typeof msg.deviceName === "string" ? msg.deviceName.trim().slice(0, 50) : "Device";
          const platform = typeof msg.platform === "string" ? msg.platform : "browser";

          if (!code || code.length < 3) {
            sendJson(ws, { type: "error", message: "Invalid channel code." });
            return;
          }

          if (!rawDeviceId) {
            sendJson(ws, { type: "error", message: "Missing required deviceId." });
            return;
          }

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
          
          const existing = room.get(rawDeviceId);
          if (existing && existing.ws !== ws) {
            sendJson(existing.ws, { type: "error", message: "Device reconnected." });
            existing.ws.close();
          }

          room.set(rawDeviceId, session);
          console.log(`[WS] register ${session.deviceId} ${session.deviceName}`);
          console.log(`[CHANNEL] ${session.deviceId} joined ${code}`);

          const sync = getOrCreateFirestoreSync(code);
          
          if (sync) {
            await sync.registerLocalDevice({
              id: session.deviceId,
              name: session.deviceName,
              platform: session.platform,
              joinedAt: session.joinedAt
            });
            
            const syncDevices = sync.getAllMembers().filter(m => m.id !== session.deviceId);
            const localDevices = Array.from(room.values())
              .filter(p => p.deviceId !== session.deviceId)
              .map(p => ({
                id: p.deviceId,
                name: p.deviceName,
                platform: p.platform,
                joinedAt: p.joinedAt,
              }));
              
            // Merge maps by ID to avoid duplicates
            const allDevicesMap = new Map<string, DeviceInfo>();
            for (const d of syncDevices) allDevicesMap.set(d.id, d);
            for (const d of localDevices) allDevicesMap.set(d.id, d);
            
            const devices = Array.from(allDevicesMap.values());
            console.log(`[CHANNEL] ${code} members=${devices.length} devices=${devices.map(d => d.id).join(",")}`);
            
            sendJson(ws, {
              type: "joined",
              channelCode: code,
              self: { id: session.deviceId, name: session.deviceName, platform: session.platform, joinedAt: session.joinedAt },
              devices: devices,
            });

            // Immediately notify local peers in case onSnapshot is delayed
            const newMemberInfo: DeviceInfo = {
              id: session.deviceId,
              name: session.deviceName,
              platform: session.platform,
              joinedAt: session.joinedAt,
            };
            let broadcastCount = 0;
            for (const [otherId, peer] of room.entries()) {
              if (otherId !== session.deviceId) {
                sendJson(peer.ws, {
                  type: "device-joined",
                  channelCode: code,
                  device: newMemberInfo,
                });
                broadcastCount++;
              }
            }
            console.log(`[CHANNEL] broadcasting members to ${broadcastCount} clients locally`);

          } else {
            // Local memory fallback mode
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
            console.log(`[CHANNEL] ${code} members=${membersList.length} devices=${membersList.map(d => d.id).join(",")}`);
            sendJson(ws, {
              type: "joined",
              channelCode: code,
              self: { id: session.deviceId, name: session.deviceName, platform: session.platform, joinedAt: session.joinedAt },
              devices: membersList,
            });

            const newMemberInfo: DeviceInfo = {
              id: session.deviceId,
              name: session.deviceName,
              platform: session.platform,
              joinedAt: session.joinedAt,
            };
            let broadcastCount = 0;
            for (const [otherId, peer] of room.entries()) {
              if (otherId !== session.deviceId) {
                sendJson(peer.ws, {
                  type: "device-joined",
                  channelCode: code,
                  device: newMemberInfo,
                });
                broadcastCount++;
              }
            }
            console.log(`[CHANNEL] broadcasting members to ${broadcastCount} clients locally`);
          }
          break;
        }
        case "leave": {
          removeSessionFromChannel(session);
          sendJson(ws, { type: "left" });
          break;
        }
        case "rename": {
          const newName = typeof msg.deviceName === "string" ? msg.deviceName.trim().slice(0, 50) : "";
          if (newName) {
            session.deviceName = newName;
            const code = session.channelCode;
            
            const sync = firestoreSyncs.get(code);
            if (sync) {
              await sync.registerLocalDevice({
                id: session.deviceId,
                name: session.deviceName,
                platform: session.platform,
                joinedAt: session.joinedAt
              });
            } else if (code && localChannels.has(code)) {
              const room = localChannels.get(code)!;
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
      console.error("[Error] Failed to process incoming message:", err);
    }
  });

  ws.on("close", () => {
    console.log(`[Disconnect] Client ${session.deviceName} (${session.deviceId || "unregistered"}) disconnected`);
    removeSessionFromChannel(session);
    socketSessions.delete(ws);
  });

  ws.on("error", (err: Error) => {
    console.warn(`[Socket Error] ${session.deviceId}:`, err.message);
  });
});

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
  console.log(`=======================================================`);
});
