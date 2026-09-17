import type { Device } from "./types";

export type SignalingState = "idle" | "connecting" | "connected" | "reconnecting" | "offline";

export interface SignalingEvent {
  timestamp: number;
  event: string;
  detail?: string;
}

export interface SignalingCallbacks {
  onStateChange?: (state: SignalingState, detail?: string) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onJoined?: (data: { channelCode: string; self: { id: string; name: string; platform: string }; devices: Device[]; revision?: number }) => void;
  onMembersUpdated?: (data: { channelCode: string; revision: number; devices: Device[] }) => void;
  onDeviceUpdated?: (device: Device) => void;
  onOffer?: (data: { fromDeviceId: string; sdp: RTCSessionDescriptionInit }) => void;
  onAnswer?: (data: { fromDeviceId: string; sdp: RTCSessionDescriptionInit }) => void;
  onIceCandidate?: (data: { fromDeviceId: string; candidate: RTCIceCandidateInit }) => void;
  onError?: (message: string) => void;
  onEvent?: (event: SignalingEvent) => void;
}

export function getDefaultSignalingUrl(): string {
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_SIGNALING_URL) {
    return process.env.NEXT_PUBLIC_SIGNALING_URL;
  }
  return "";
}

export class SignalingClient {
  private url: string;
  private ws: WebSocket | null = null;
  private callbacks: SignalingCallbacks;
  
  private state: SignalingState = "idle";
  private reconnectTimer: number | null = null;
  private pingInterval: number | null = null;
  private watchdogInterval: number | null = null;
  private reconnectAttempt = 0;
  private isExplicitlyClosed = false;
  private lastServerActivity = Date.now();
  private lastRevision = 0;

  public currentChannel = "";
  public currentDeviceId = "";
  public currentDeviceName = "";
  public currentPlatform = "browser";
  public isConnected = false;

  constructor(callbacks: SignalingCallbacks, customUrl?: string) {
    this.callbacks = callbacks;
    this.url = customUrl || getDefaultSignalingUrl();
  }

  public getUrl(): string {
    return this.url;
  }

  public getState(): SignalingState {
    return this.state;
  }

  private setState(nextState: SignalingState, detail?: string) {
    if (this.state !== nextState) {
      this.state = nextState;
      this.isConnected = nextState === "connected";
      this.logEvent(`state-${nextState}`, detail);
      this.callbacks.onStateChange?.(nextState, detail);
    }
  }

  private logEvent(event: string, detail?: string) {
    const entry: SignalingEvent = { timestamp: Date.now(), event, detail };
    console.log(`[Signaling] ${event}${detail ? ': ' + detail : ''}`);
    this.callbacks.onEvent?.(entry);
  }

  public connect(channelCode: string, deviceId: string, deviceName: string, platform: string = "browser") {
    this.isExplicitlyClosed = false;
    this.currentChannel = channelCode.trim().toUpperCase();
    this.currentDeviceId = deviceId;
    this.currentDeviceName = deviceName;
    this.currentPlatform = platform;

    if (!this.url) {
      console.warn("[SignalingClient] No signaling URL configured.");
      this.setState("offline", "No signaling URL");
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.closeSocket();
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting", `url=${this.url}`);
    this.logEvent("ws-connecting", `Connecting to ${this.url}`);

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.lastServerActivity = Date.now();
        this.logEvent("ws-connected", `Connected to ${this.url}`);
        this.callbacks.onConnected?.();

        // Send deterministic join request with persistent deviceId and channelCode
        this.logEvent("join-sending", `channel=${this.currentChannel} device=${this.currentDeviceId} name=${this.currentDeviceName}`);
        this.send({
          type: "join",
          channelCode: this.currentChannel,
          deviceId: this.currentDeviceId,
          deviceName: this.currentDeviceName,
          platform: this.currentPlatform,
        });

        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        this.lastServerActivity = Date.now();
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (err) {
          console.warn("[SignalingClient] Message parse error:", err);
        }
      };

      this.ws.onclose = (ev) => {
        this.stopHeartbeat();
        this.closeSocket();
        this.callbacks.onDisconnected?.();
        this.logEvent("ws-disconnected", `Code: ${ev.code}, Reason: ${ev.reason || "none"}`);

        if (!this.isExplicitlyClosed) {
          this.setState("reconnecting", `Attempt #${this.reconnectAttempt + 1}`);
          this.scheduleReconnect();
        } else {
          this.setState("idle", "Closed explicitly");
        }
      };

      this.ws.onerror = () => {
        this.logEvent("ws-error", `WebSocket connection failed on ${this.url}`);
      };
    } catch (err) {
      console.warn("[SignalingClient] Socket initialization error:", err);
      if (!this.isExplicitlyClosed) {
        this.setState("reconnecting", "Init failed");
        this.scheduleReconnect();
      }
    }
  }

  public send(data: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (err) {
        console.warn("[SignalingClient] Failed to send message:", err);
      }
    }
  }

  public switchChannel(newChannelCode: string) {
    const code = newChannelCode.trim().toUpperCase();
    if (!code) return;

    this.currentChannel = code;
    this.lastRevision = 0;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        type: "join",
        channelCode: code,
        deviceId: this.currentDeviceId,
        deviceName: this.currentDeviceName,
        platform: this.currentPlatform,
      });
    } else {
      this.connect(code, this.currentDeviceId, this.currentDeviceName, this.currentPlatform);
    }
  }

  public renameDevice(newName: string) {
    this.currentDeviceName = newName;
    this.send({
      type: "rename",
      deviceName: newName,
    });
  }

  public leaveChannel() {
    this.send({ type: "leave" });
    this.currentChannel = "";
    this.lastRevision = 0;
  }

  public sendOffer(targetDeviceId: string, sdp: RTCSessionDescriptionInit) {
    this.send({
      type: "offer",
      targetDeviceId,
      fromDeviceId: this.currentDeviceId,
      sdp,
    });
  }

  public sendAnswer(targetDeviceId: string, sdp: RTCSessionDescriptionInit) {
    this.send({
      type: "answer",
      targetDeviceId,
      fromDeviceId: this.currentDeviceId,
      sdp,
    });
  }

  public sendIceCandidate(targetDeviceId: string, candidate: RTCIceCandidateInit) {
    this.send({
      type: "ice-candidate",
      targetDeviceId,
      fromDeviceId: this.currentDeviceId,
      candidate,
    });
  }

  public disconnect() {
    this.isExplicitlyClosed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.setState("idle", "Disconnected");
  }

  private closeSocket() {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
      } catch {}
      this.ws = null;
      this.isConnected = false;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();

    // 1. Send periodic ping every 10 seconds
    this.pingInterval = window.setInterval(() => {
      this.send({ type: "ping" });
    }, 10000);

    // 2. Watchdog: if no message/pong received from server for >35s, treat connection as stale
    this.watchdogInterval = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (Date.now() - this.lastServerActivity > 35000) {
          console.warn("[SignalingClient] Server heartbeat timeout (stale connection). Reconnecting...");
          this.logEvent("watchdog-timeout", "No server response in 35s");
          this.closeSocket();
          this.scheduleReconnect();
        }
      }
    }, 5000);
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.isExplicitlyClosed) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s + jitter
    const baseDelay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempt, 5)), 30000);
    const jitter = Math.floor(Math.random() * 500);
    const delay = baseDelay + jitter;

    this.reconnectAttempt++;
    this.logEvent("schedule-reconnect", `Attempt #${this.reconnectAttempt} in ${delay}ms`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isExplicitlyClosed && this.currentChannel && this.currentDeviceId) {
        console.log(`[SignalingClient] Executing reconnect attempt #${this.reconnectAttempt}...`);
        this.connect(this.currentChannel, this.currentDeviceId, this.currentDeviceName, this.currentPlatform);
      }
    }, delay);
  }

  private handleMessage(msg: {
    type: string;
    channelCode?: string;
    deviceId?: string;
    revision?: number;
    code?: string;
    self?: { id: string; name: string; platform: string };
    devices?: Array<{ id: string; name: string; platform: string; joinedAt?: number }>;
    members?: Array<{ id: string; name: string; platform: string; joinedAt?: number }>;
    device?: { id: string; name: string; platform: string; joinedAt?: number };
    fromDeviceId?: string;
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    message?: string;
  }) {
    switch (msg.type) {
      case "join_ack": {
        const rev = msg.revision || 0;
        this.lastRevision = rev;
        this.reconnectAttempt = 0; // Reset backoff on successful join
        this.setState("connected", `Channel ${msg.channelCode} joined`);
        this.logEvent("join_ack", `channel=${msg.channelCode} revision=${rev} peers=${(msg.members || []).length}`);

        const rawMembers = msg.members || [];
        const formattedDevices: Device[] = rawMembers.map((d) => ({
          id: d.id,
          userId: d.id,
          accountId: msg.channelCode || this.currentChannel,
          name: d.name,
          type: d.platform || "browser",
          pairingCode: msg.channelCode || this.currentChannel,
          online: true,
          state: "ONLINE",
          lastSeen: d.joinedAt || Date.now(),
          createdAt: d.joinedAt || Date.now(),
        }));

        this.callbacks.onJoined?.({
          channelCode: msg.channelCode || this.currentChannel,
          self: { id: this.currentDeviceId, name: this.currentDeviceName, platform: this.currentPlatform },
          devices: formattedDevices,
          revision: rev,
        });

        this.callbacks.onMembersUpdated?.({
          channelCode: msg.channelCode || this.currentChannel,
          revision: rev,
          devices: formattedDevices,
        });
        break;
      }

      case "join_error": {
        this.logEvent("join_error", `${msg.code}: ${msg.message}`);
        this.callbacks.onError?.(msg.message || "Failed to join channel.");
        break;
      }

      case "members": {
        const rev = msg.revision || 0;
        if (rev < this.lastRevision && rev !== 0) {
          console.warn(`[SignalingClient] Discarding stale members snapshot (got rev ${rev}, have rev ${this.lastRevision})`);
          break;
        }
        this.lastRevision = rev;
        this.reconnectAttempt = 0;
        this.setState("connected", `Revision ${rev}`);

        const rawDevices = msg.devices || [];
        this.logEvent("members", `channel=${msg.channelCode} revision=${rev} peers=${rawDevices.length}`);
        
        const formattedDevices: Device[] = rawDevices.map((d) => ({
          id: d.id,
          userId: d.id,
          accountId: msg.channelCode || this.currentChannel,
          name: d.name,
          type: d.platform || "browser",
          pairingCode: msg.channelCode || this.currentChannel,
          online: true,
          state: "ONLINE",
          lastSeen: d.joinedAt || Date.now(),
          createdAt: d.joinedAt || Date.now(),
        }));

        this.callbacks.onMembersUpdated?.({
          channelCode: msg.channelCode || this.currentChannel,
          revision: rev,
          devices: formattedDevices,
        });
        break;
      }

      case "device-updated": {
        if (msg.device) {
          const d = msg.device;
          const formatted: Device = {
            id: d.id,
            userId: d.id,
            accountId: msg.channelCode || this.currentChannel,
            name: d.name,
            type: d.platform || "browser",
            pairingCode: msg.channelCode || this.currentChannel,
            online: true,
            state: "ONLINE",
            lastSeen: Date.now(),
            createdAt: Date.now(),
          };
          this.callbacks.onDeviceUpdated?.(formatted);
        }
        break;
      }

      case "offer": {
        if (msg.fromDeviceId && msg.sdp) {
          this.logEvent("offer-received", `from ${msg.fromDeviceId}`);
          this.callbacks.onOffer?.({ fromDeviceId: msg.fromDeviceId, sdp: msg.sdp });
        }
        break;
      }

      case "answer": {
        if (msg.fromDeviceId && msg.sdp) {
          this.logEvent("answer-received", `from ${msg.fromDeviceId}`);
          this.callbacks.onAnswer?.({ fromDeviceId: msg.fromDeviceId, sdp: msg.sdp });
        }
        break;
      }

      case "ice-candidate": {
        if (msg.fromDeviceId && msg.candidate) {
          this.logEvent("ice-candidate", `from ${msg.fromDeviceId}`);
          this.callbacks.onIceCandidate?.({ fromDeviceId: msg.fromDeviceId, candidate: msg.candidate });
        }
        break;
      }

      case "error": {
        if (msg.message) {
          this.logEvent("server-error", msg.message);
          this.callbacks.onError?.(msg.message);
        }
        break;
      }

      case "pong":
        break;
    }
  }
}
