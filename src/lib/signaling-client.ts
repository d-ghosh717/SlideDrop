import type { Device } from "./types";

export interface SignalingEvent {
  timestamp: number;
  event: string;
  detail?: string;
}

export interface SignalingCallbacks {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onJoined?: (data: { channelCode: string; self: { id: string; name: string; platform: string }; devices: Device[] }) => void;
  onDeviceJoined?: (device: Device) => void;
  onDeviceUpdated?: (device: Device) => void;
  onDeviceLeft?: (deviceId: string) => void;
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
  console.warn("NEXT_PUBLIC_SIGNALING_URL is not set. WebSocket signaling will fail.");
  return "";
}

export class SignalingClient {
  private url: string;
  private ws: WebSocket | null = null;
  private callbacks: SignalingCallbacks;
  private reconnectTimer: number | null = null;
  private pingInterval: number | null = null;
  private isExplicitlyClosed = false;

  public currentChannel: string = "";
  public currentDeviceId: string = "";
  public currentDeviceName: string = "";
  public currentPlatform: string = "browser";
  public isConnected = false;

  constructor(callbacks: SignalingCallbacks, customUrl?: string) {
    this.callbacks = callbacks;
    this.url = customUrl || getDefaultSignalingUrl();
  }

  public getUrl(): string {
    return this.url;
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

    if (this.ws) {
      this.closeSocket();
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.logEvent('ws-connected', `Connected to ${this.url}`);
        this.callbacks.onConnected?.();

        // Immediately join the requested channel
        this.logEvent('join-sending', `channel=${this.currentChannel} device=${this.currentDeviceId} name=${this.currentDeviceName}`);
        this.send({
          type: "join",
          channelCode: this.currentChannel,
          deviceId: this.currentDeviceId,
          deviceName: this.currentDeviceName,
          platform: this.currentPlatform,
        });

        // Start ping heartbeat
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (err) {
          console.warn("[SignalingClient] Message parse error:", err);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.stopHeartbeat();
        this.logEvent('ws-disconnected', `Disconnected from ${this.url}`);
        this.callbacks.onDisconnected?.();

        if (!this.isExplicitlyClosed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.logEvent('ws-error', `WebSocket error on ${this.url}`);
      };
    } catch (err) {
      console.warn("[SignalingClient] Connect attempt error:", err);
      if (!this.isExplicitlyClosed) {
        this.scheduleReconnect();
      }
    }
  }

  public send(data: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  public switchChannel(newChannelCode: string) {
    const code = newChannelCode.trim().toUpperCase();
    this.currentChannel = code;
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
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
    this.pingInterval = window.setInterval(() => {
      this.send({ type: "ping" });
    }, 10000);
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.isExplicitlyClosed) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isExplicitlyClosed && this.currentChannel && this.currentDeviceId) {
        console.log("[SignalingClient] Attempting reconnect to", this.url);
        this.connect(this.currentChannel, this.currentDeviceId, this.currentDeviceName, this.currentPlatform);
      }
    }, 3000);
  }

  private handleMessage(msg: {
    type: string;
    channelCode?: string;
    self?: { id: string; name: string; platform: string };
    devices?: Array<{ id: string; name: string; platform: string; joinedAt?: number }>;
    device?: { id: string; name: string; platform: string; joinedAt?: number };
    deviceId?: string;
    fromDeviceId?: string;
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    message?: string;
  }) {
    switch (msg.type) {
      case "joined": {
        const rawDevices = msg.devices || [];
        this.logEvent('joined', `channel=${msg.channelCode} peers=${rawDevices.length} (${rawDevices.map(d => d.name).join(', ') || 'none'})`);
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

        this.callbacks.onJoined?.({
          channelCode: msg.channelCode || this.currentChannel,
          self: msg.self || { id: this.currentDeviceId, name: this.currentDeviceName, platform: this.currentPlatform },
          devices: formattedDevices,
        });
        break;
      }

      case "device-joined": {
        if (msg.device) {
          const d = msg.device;
          this.logEvent('device-joined', `${d.name} (${d.id}) joined channel`);
          const formatted: Device = {
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
          };
          this.callbacks.onDeviceJoined?.(formatted);
        }
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

      case "device-left": {
        if (msg.deviceId) {
          this.logEvent('device-left', `Device ${msg.deviceId} left channel`);
          this.callbacks.onDeviceLeft?.(msg.deviceId);
        }
        break;
      }

      case "offer": {
        if (msg.fromDeviceId && msg.sdp) {
          this.logEvent('offer-received', `from ${msg.fromDeviceId}`);
          this.callbacks.onOffer?.({ fromDeviceId: msg.fromDeviceId, sdp: msg.sdp });
        }
        break;
      }

      case "answer": {
        if (msg.fromDeviceId && msg.sdp) {
          this.logEvent('answer-received', `from ${msg.fromDeviceId}`);
          this.callbacks.onAnswer?.({ fromDeviceId: msg.fromDeviceId, sdp: msg.sdp });
        }
        break;
      }

      case "ice-candidate": {
        if (msg.fromDeviceId && msg.candidate) {
          this.logEvent('ice-candidate', `from ${msg.fromDeviceId}`);
          this.callbacks.onIceCandidate?.({ fromDeviceId: msg.fromDeviceId, candidate: msg.candidate });
        }
        break;
      }

      case "error": {
        if (msg.message) {
          this.logEvent('server-error', msg.message);
          this.callbacks.onError?.(msg.message);
        }
        break;
      }

      case "pong":
        break;
    }
  }
}
