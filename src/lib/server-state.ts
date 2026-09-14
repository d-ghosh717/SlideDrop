// In-memory channel, presence, and signaling store for SlideDrop
// Supports instant cross-device discovery on localhost, local Wi-Fi LAN, and cloud deployments.

export type ServerDevice = {
  deviceId: string;
  deviceName: string;
  platform: string;
  channelCode: string;
  lastSeen: number;
  online: boolean;
};

export type SignalPayload = {
  id: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  channelCode: string;
  type: "offer" | "answer" | "candidate";
  data: RTCSessionDescriptionInit | RTCIceCandidateInit;
  timestamp: number;
};

export type RelayTransfer = {
  id: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  channelCode: string;
  senderName: string;
  recipientName: string;
  filename: string;
  mimeType: string;
  size: number;
  textContent?: string;
  fileData?: string;
  status: "completed" | "pending";
  timestamp: number;
};

// Global singleton in Node runtime to persist across API requests
interface GlobalState {
  channels: Map<string, Map<string, ServerDevice>>; // channelCode -> Map<deviceId, ServerDevice>
  signals: SignalPayload[];
  transfers: Map<string, RelayTransfer[]>; // channelCode -> RelayTransfer[]
}

const globalForSlideDrop = globalThis as unknown as { __slidedrop_state?: GlobalState };

export const serverState: GlobalState = globalForSlideDrop.__slidedrop_state || {
  channels: new Map(),
  signals: [],
  transfers: new Map(),
};

if (process.env.NODE_ENV !== "production") {
  globalForSlideDrop.__slidedrop_state = serverState;
}

// Clean up stale devices (older than 20 seconds) and stale signals (older than 60 seconds)
export function cleanupStaleState() {
  const now = Date.now();
  const HEARTBEAT_TIMEOUT = 20 * 1000;
  const SIGNAL_TIMEOUT = 60 * 1000;

  for (const [code, deviceMap] of serverState.channels.entries()) {
    for (const [deviceId, device] of deviceMap.entries()) {
      if (now - device.lastSeen > HEARTBEAT_TIMEOUT) {
        deviceMap.delete(deviceId);
      }
    }
    if (deviceMap.size === 0) {
      serverState.channels.delete(code);
    }
  }

  serverState.signals = serverState.signals.filter((s) => now - s.timestamp < SIGNAL_TIMEOUT);
}

// Register or update device presence in a channel
export function registerDevice(code: string, device: ServerDevice): ServerDevice[] {
  cleanupStaleState();
  const normalizedCode = code.trim().toUpperCase();
  if (!serverState.channels.has(normalizedCode)) {
    serverState.channels.set(normalizedCode, new Map());
  }

  const deviceMap = serverState.channels.get(normalizedCode)!;
  deviceMap.set(device.deviceId, {
    ...device,
    channelCode: normalizedCode,
    lastSeen: Date.now(),
    online: true,
  });

  return Array.from(deviceMap.values());
}

// Get active devices in a channel
export function getActiveDevices(code: string): ServerDevice[] {
  cleanupStaleState();
  const normalizedCode = code.trim().toUpperCase();
  const deviceMap = serverState.channels.get(normalizedCode);
  if (!deviceMap) return [];
  return Array.from(deviceMap.values());
}

// Remove device on leave
export function removeDevice(code: string, deviceId: string): ServerDevice[] {
  const normalizedCode = code.trim().toUpperCase();
  const deviceMap = serverState.channels.get(normalizedCode);
  if (deviceMap) {
    deviceMap.delete(deviceId);
    if (deviceMap.size === 0) {
      serverState.channels.delete(normalizedCode);
    }
    return Array.from(deviceMap.values());
  }
  return [];
}

// Push signaling message (offer, answer, candidate)
export function pushSignal(signal: SignalPayload) {
  cleanupStaleState();
  serverState.signals.push(signal);
}

// Pull signaling messages for a specific device
export function pullSignals(channelCode: string, recipientDeviceId: string, since = 0): SignalPayload[] {
  cleanupStaleState();
  const normalizedCode = channelCode.trim().toUpperCase();
  return serverState.signals.filter(
    (s) =>
      s.channelCode === normalizedCode &&
      s.recipientDeviceId === recipientDeviceId &&
      s.timestamp > since
  );
}

// Add relay transfer
export function addRelayTransfer(transfer: RelayTransfer) {
  const normalizedCode = transfer.channelCode.trim().toUpperCase();
  if (!serverState.transfers.has(normalizedCode)) {
    serverState.transfers.set(normalizedCode, []);
  }
  const list = serverState.transfers.get(normalizedCode)!;
  list.unshift(transfer);
  if (list.length > 50) list.pop(); // keep last 50
}

// Get relay transfers for channel
export function getRelayTransfers(channelCode: string): RelayTransfer[] {
  const normalizedCode = channelCode.trim().toUpperCase();
  return serverState.transfers.get(normalizedCode) || [];
}
