import { SignalingClient } from "./signaling-client";

export type WebRTCDataMessage =
  | { type: "text"; transferId: string; text: string; senderName: string; timestamp: number }
  | { type: "text-ack"; transferId: string }
  | { type: "file-start"; transferId: string; filename: string; mimeType: string; size: number; totalChunks: number; senderName: string }
  | { type: "file-chunk"; transferId: string; chunkIndex: number; data: string }
  | { type: "file-end"; transferId: string }
  | { type: "file-ack"; transferId: string };

export type WebRTCCallbacks = {
  onPeerConnected?: (peerDeviceId: string) => void;
  onPeerDisconnected?: (peerDeviceId: string) => void;
  onPeerStateChange?: (peerDeviceId: string, state: "connecting" | "connected" | "disconnected") => void;
  onTextMessage?: (message: { id: string; text: string; senderName: string; timestamp: number; peerDeviceId: string }) => void;
  onFileProgress?: (transferId: string, percent: number, direction: "send" | "receive") => void;
  onFileReceived?: (fileTransfer: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    downloadUrl: string;
    senderName: string;
    timestamp: number;
  }) => void;
  onTransferAcknowledged?: (transferId: string) => void;
};

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

const CHUNK_SIZE = 16 * 1024; // 16 KB chunks for reliable WebRTC transmission
const MAX_BUFFERED_AMOUNT = 64 * 1024; // 64 KB threshold for backpressure

export class WebRTCManager {
  private signaling: SignalingClient;
  private localDeviceId: string;
  private localDeviceName: string;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  private incomingFiles: Map<string, {
    meta: { transferId: string; filename: string; mimeType: string; size: number; totalChunks: number; senderName: string };
    chunks: string[];
    receivedCount: number;
  }> = new Map();
  private callbacks: WebRTCCallbacks;

  constructor(
    signaling: SignalingClient,
    localDeviceId: string,
    localDeviceName: string,
    callbacks: WebRTCCallbacks
  ) {
    this.signaling = signaling;
    this.localDeviceId = localDeviceId;
    this.localDeviceName = localDeviceName;
    this.callbacks = callbacks;
  }

  public isConnectedToPeer(peerDeviceId: string): boolean {
    const dc = this.dataChannels.get(peerDeviceId);
    return dc !== undefined && dc.readyState === "open";
  }

  public getConnectedPeerCount(): number {
    let count = 0;
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === "open") count++;
    }
    return count;
  }

  public getConnectedPeerIds(): string[] {
    const list: string[] = [];
    for (const [id, dc] of this.dataChannels.entries()) {
      if (dc.readyState === "open") list.push(id);
    }
    return list;
  }

  public syncPeers(remoteDeviceIds: string[]) {
    for (const remoteId of remoteDeviceIds) {
      if (remoteId === this.localDeviceId) continue;

      if (!this.peerConnections.has(remoteId)) {
        // Deterministic role: smaller lexicographical ID is the offerer
        const isOfferer = this.localDeviceId < remoteId;
        if (isOfferer) {
          console.log(`[WebRTC] Initiating offer to peer ${remoteId}`);
          this.initiateOffer(remoteId);
        }
      }
    }

    // Close and remove peers that left
    for (const peerId of this.peerConnections.keys()) {
      if (!remoteDeviceIds.includes(peerId)) {
        this.closePeer(peerId);
      }
    }
  }

  public handleRemoteOffer(fromDeviceId: string, sdp: RTCSessionDescriptionInit) {
    this.handleOffer(fromDeviceId, sdp);
  }

  public handleRemoteAnswer(fromDeviceId: string, sdp: RTCSessionDescriptionInit) {
    this.handleAnswer(fromDeviceId, sdp);
  }

  public handleRemoteIceCandidate(fromDeviceId: string, candidate: RTCIceCandidateInit) {
    this.handleCandidate(fromDeviceId, candidate);
  }

  public closePeer(peerDeviceId: string) {
    const pc = this.peerConnections.get(peerDeviceId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerDeviceId);
    }
    const dc = this.dataChannels.get(peerDeviceId);
    if (dc) {
      dc.close();
      this.dataChannels.delete(peerDeviceId);
    }
    this.pendingCandidates.delete(peerDeviceId);
    this.callbacks.onPeerDisconnected?.(peerDeviceId);
    this.callbacks.onPeerStateChange?.(peerDeviceId, "disconnected");
  }

  public closeAllPeers() {
    for (const peerId of Array.from(this.peerConnections.keys())) {
      this.closePeer(peerId);
    }
    this.peerConnections.clear();
    this.dataChannels.clear();
    this.pendingCandidates.clear();
    this.incomingFiles.clear();
  }

  private getOrCreatePeerConnection(peerDeviceId: string): RTCPeerConnection {
    if (this.peerConnections.has(peerDeviceId)) {
      return this.peerConnections.get(peerDeviceId)!;
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    this.peerConnections.set(peerDeviceId, pc);
    this.callbacks.onPeerStateChange?.(peerDeviceId, "connecting");

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(peerDeviceId, event.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Peer ${peerDeviceId} connectionState: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        this.callbacks.onPeerStateChange?.(peerDeviceId, "connected");
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.callbacks.onPeerStateChange?.(peerDeviceId, "disconnected");
        this.closePeer(peerDeviceId);
      }
    };

    pc.ondatachannel = (event) => {
      console.log(`[WebRTC] Received DataChannel from ${peerDeviceId}`);
      this.setupDataChannel(peerDeviceId, event.channel);
    };

    return pc;
  }

  private setupDataChannel(peerDeviceId: string, channel: RTCDataChannel) {
    this.dataChannels.set(peerDeviceId, channel);
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      console.log(`[WebRTC] DataChannel OPEN with ${peerDeviceId}`);
      this.callbacks.onPeerConnected?.(peerDeviceId);
      this.callbacks.onPeerStateChange?.(peerDeviceId, "connected");
    };

    channel.onclose = () => {
      console.log(`[WebRTC] DataChannel CLOSED with ${peerDeviceId}`);
      this.callbacks.onPeerDisconnected?.(peerDeviceId);
      this.callbacks.onPeerStateChange?.(peerDeviceId, "disconnected");
      this.dataChannels.delete(peerDeviceId);
    };

    channel.onerror = (err) => {
      console.warn(`[WebRTC] DataChannel error with ${peerDeviceId}`, err);
    };

    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WebRTCDataMessage;
        this.handleIncomingMessage(peerDeviceId, msg);
      } catch (err) {
        console.warn("[WebRTC] Could not parse incoming DataChannel message:", err);
      }
    };
  }

  private async initiateOffer(peerDeviceId: string) {
    const pc = this.getOrCreatePeerConnection(peerDeviceId);
    const dataChannel = pc.createDataChannel("slidedrop-p2p", { ordered: true });
    this.setupDataChannel(peerDeviceId, dataChannel);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.sendOffer(peerDeviceId, offer);
    } catch (err) {
      console.warn(`[WebRTC] Error creating offer for ${peerDeviceId}:`, err);
    }
  }

  private async handleOffer(peerDeviceId: string, offer: RTCSessionDescriptionInit) {
    const pc = this.getOrCreatePeerConnection(peerDeviceId);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      this.drainPendingCandidates(peerDeviceId);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.sendAnswer(peerDeviceId, answer);
    } catch (err) {
      console.warn(`[WebRTC] Error handling offer from ${peerDeviceId}:`, err);
    }
  }

  private async handleAnswer(peerDeviceId: string, answer: RTCSessionDescriptionInit) {
    const pc = this.peerConnections.get(peerDeviceId);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      this.drainPendingCandidates(peerDeviceId);
    } catch (err) {
      console.warn(`[WebRTC] Error handling answer from ${peerDeviceId}:`, err);
    }
  }

  private async handleCandidate(peerDeviceId: string, candidate: RTCIceCandidateInit) {
    const pc = this.peerConnections.get(peerDeviceId);
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn(`[WebRTC] Error adding ICE candidate from ${peerDeviceId}:`, err);
      }
    } else {
      if (!this.pendingCandidates.has(peerDeviceId)) {
        this.pendingCandidates.set(peerDeviceId, []);
      }
      this.pendingCandidates.get(peerDeviceId)!.push(candidate);
    }
  }

  private async drainPendingCandidates(peerDeviceId: string) {
    const candidates = this.pendingCandidates.get(peerDeviceId);
    const pc = this.peerConnections.get(peerDeviceId);
    if (candidates && pc && pc.remoteDescription) {
      for (const cand of candidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (err) {
          console.warn("[WebRTC] Error adding drained candidate:", err);
        }
      }
      this.pendingCandidates.delete(peerDeviceId);
    }
  }

  // Send Text Note over WebRTC DataChannel
  public sendText(text: string, senderName: string, targetPeerId?: string): boolean {
    const transferId = "txt_" + Math.random().toString(36).substring(2, 10);
    const msg: WebRTCDataMessage = {
      type: "text",
      transferId,
      text,
      senderName,
      timestamp: Date.now(),
    };
    const payload = JSON.stringify(msg);

    let sent = false;
    for (const [peerId, dc] of this.dataChannels.entries()) {
      if (targetPeerId && targetPeerId !== "all" && peerId !== targetPeerId) continue;
      if (dc.readyState === "open") {
        dc.send(payload);
        sent = true;
      }
    }
    return sent;
  }

  // Send File with Chunking, Backpressure & Confirmation over WebRTC DataChannel
  public async sendFile(
    file: File,
    senderName: string,
    targetPeerId?: string,
    onProgress?: (percent: number) => void
  ): Promise<boolean> {
    const openChannels: { peerId: string; dc: RTCDataChannel }[] = [];
    for (const [peerId, dc] of this.dataChannels.entries()) {
      if (targetPeerId && targetPeerId !== "all" && peerId !== targetPeerId) continue;
      if (dc.readyState === "open") openChannels.push({ peerId, dc });
    }

    if (openChannels.length === 0) return false;

    const arrayBuffer = await file.arrayBuffer();
    const totalBytes = arrayBuffer.byteLength;
    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
    const transferId = "tr_" + Math.random().toString(36).substring(2, 10);

    // 1. Send file-start metadata header
    const startMsg: WebRTCDataMessage = {
      type: "file-start",
      transferId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      size: totalBytes,
      totalChunks,
      senderName,
    };
    const startPayload = JSON.stringify(startMsg);
    for (const { dc } of openChannels) dc.send(startPayload);

    const bufferToBase64 = (buf: ArrayBuffer): string => {
      let binary = "";
      const bytes = new Uint8Array(buf);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    };

    // 2. Stream chunks with backpressure
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalBytes);
      const chunkData = bufferToBase64(arrayBuffer.slice(start, end));

      const chunkMsg: WebRTCDataMessage = {
        type: "file-chunk",
        transferId,
        chunkIndex: i,
        data: chunkData,
      };
      const chunkPayload = JSON.stringify(chunkMsg);

      for (const { dc } of openChannels) {
        if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          await new Promise<void>((resolve) => {
            const onLow = () => {
              dc.removeEventListener("bufferedamountlow", onLow);
              resolve();
            };
            dc.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2;
            dc.addEventListener("bufferedamountlow", onLow);
          });
        }
        dc.send(chunkPayload);
      }

      const percent = Math.round(((i + 1) / totalChunks) * 100);
      onProgress?.(percent);
      this.callbacks.onFileProgress?.(transferId, percent, "send");
    }

    // 3. Send file-end notice
    const endMsg: WebRTCDataMessage = { type: "file-end", transferId };
    const endPayload = JSON.stringify(endMsg);
    for (const { dc } of openChannels) dc.send(endPayload);

    return true;
  }

  // Handle incoming data packets
  private handleIncomingMessage(peerDeviceId: string, msg: WebRTCDataMessage) {
    if (msg.type === "text") {
      this.callbacks.onTextMessage?.({
        id: msg.transferId,
        text: msg.text,
        senderName: msg.senderName,
        timestamp: msg.timestamp,
        peerDeviceId,
      });

      // Send text-ack back to sender
      const dc = this.dataChannels.get(peerDeviceId);
      if (dc && dc.readyState === "open") {
        dc.send(JSON.stringify({ type: "text-ack", transferId: msg.transferId }));
      }
    } else if (msg.type === "text-ack" || msg.type === "file-ack") {
      this.callbacks.onTransferAcknowledged?.(msg.transferId);
    } else if (msg.type === "file-start") {
      this.incomingFiles.set(msg.transferId, {
        meta: msg,
        chunks: new Array(msg.totalChunks),
        receivedCount: 0,
      });
      this.callbacks.onFileProgress?.(msg.transferId, 0, "receive");
    } else if (msg.type === "file-chunk") {
      const incoming = this.incomingFiles.get(msg.transferId);
      if (!incoming) return;

      incoming.chunks[msg.chunkIndex] = msg.data;
      incoming.receivedCount++;

      const percent = Math.round((incoming.receivedCount / incoming.meta.totalChunks) * 100);
      this.callbacks.onFileProgress?.(msg.transferId, percent, "receive");
    } else if (msg.type === "file-end") {
      const incoming = this.incomingFiles.get(msg.transferId);
      if (!incoming) return;

      try {
        const byteArrays: BlobPart[] = [];
        for (const base64Chunk of incoming.chunks) {
          if (!base64Chunk) continue;
          const binary = atob(base64Chunk);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          byteArrays.push(bytes.buffer as ArrayBuffer);
        }

        const blob = new Blob(byteArrays, { type: incoming.meta.mimeType });
        const downloadUrl = URL.createObjectURL(blob);

        this.callbacks.onFileReceived?.({
          id: incoming.meta.transferId,
          filename: incoming.meta.filename,
          mimeType: incoming.meta.mimeType,
          size: incoming.meta.size,
          downloadUrl,
          senderName: incoming.meta.senderName,
          timestamp: Date.now(),
        });

        // Send file-ack back to sender
        const dc = this.dataChannels.get(peerDeviceId);
        if (dc && dc.readyState === "open") {
          dc.send(JSON.stringify({ type: "file-ack", transferId: incoming.meta.transferId }));
        }
      } catch (err) {
        console.error("[WebRTC] Error reassembling file Blob:", err);
      } finally {
        this.incomingFiles.delete(msg.transferId);
      }
    }
  }
}
