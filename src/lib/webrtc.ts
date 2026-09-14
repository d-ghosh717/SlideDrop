import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  Firestore,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  Unsubscribe,
} from "firebase/firestore";

export type WebRTCMessage =
  | { type: "text"; id: string; text: string; senderName: string; timestamp: number }
  | { type: "file-meta"; transferId: string; filename: string; mimeType: string; size: number; totalChunks: number; senderName: string }
  | { type: "file-chunk"; transferId: string; chunkIndex: number; data: string }
  | { type: "file-complete"; transferId: string };

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
  private db: Firestore | null;
  private localDeviceId: string;
  private localUid: string;
  private channelCode: string;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  private incomingFiles: Map<string, {
    meta: { transferId: string; filename: string; mimeType: string; size: number; totalChunks: number; senderName: string };
    chunks: string[];
    receivedCount: number;
  }> = new Map();
  private callbacks: WebRTCCallbacks;
  private unsubscribeSignals: Unsubscribe | null = null;
  private processedSignalIds: Set<string> = new Set();
  private broadcastChannel: BroadcastChannel | null = null;

  constructor(
    db: Firestore | null,
    localDeviceId: string,
    localUid: string,
    channelCode: string,
    callbacks: WebRTCCallbacks
  ) {
    this.db = db;
    this.localDeviceId = localDeviceId;
    this.localUid = localUid;
    this.channelCode = channelCode.toUpperCase();
    this.callbacks = callbacks;
  }

  public startSignaling() {
    if (this.unsubscribeSignals) return;

    // 1. BroadcastChannel for fast local same-origin tab signaling
    if (typeof window !== "undefined" && "BroadcastChannel" in window) {
      try {
        this.broadcastChannel = new BroadcastChannel(`slidedrop_signals_${this.channelCode}`);
        this.broadcastChannel.onmessage = async (event) => {
          const { senderDeviceId, recipientDeviceId, type, data } = event.data || {};
          if (senderDeviceId === this.localDeviceId) return;
          if (recipientDeviceId && recipientDeviceId !== "all" && recipientDeviceId !== this.localDeviceId) return;

          const payload = typeof data === "string" ? JSON.parse(data) : data;
          if (type === "offer") {
            await this.handleOffer(senderDeviceId, payload);
          } else if (type === "answer") {
            await this.handleAnswer(senderDeviceId, payload);
          } else if (type === "candidate") {
            await this.handleCandidate(senderDeviceId, payload);
          }
        };
      } catch (err) {
        console.warn("BroadcastChannel error:", err);
      }
    }

    // 2. Cloud Firestore signaling for cross-device / cross-machine signaling
    if (this.db) {
      try {
        const signalsRef = collection(this.db, "channels", this.channelCode, "signals");
        const q = query(signalsRef, where("recipientDeviceId", "==", this.localDeviceId));

        this.unsubscribeSignals = onSnapshot(
          q,
          (snapshot) => {
            snapshot.docChanges().forEach(async (change) => {
              if (change.type === "added") {
                const docId = change.doc.id;
                if (this.processedSignalIds.has(docId)) return;
                this.processedSignalIds.add(docId);

                const data = change.doc.data();
                const senderId = data.senderDeviceId as string;
                const type = data.type as "offer" | "answer" | "candidate";
                const payload = typeof data.data === "string" ? JSON.parse(data.data) : data.data;

                if (type === "offer") {
                  await this.handleOffer(senderId, payload);
                } else if (type === "answer") {
                  await this.handleAnswer(senderId, payload);
                } else if (type === "candidate") {
                  await this.handleCandidate(senderId, payload);
                }

                if (this.db) {
                  deleteDoc(doc(this.db, "channels", this.channelCode, "signals", docId)).catch(() => {});
                }
              }
            });
          },
          (error) => {
            console.warn("Firestore signaling listener notice:", error.message);
          }
        );
      } catch (err) {
        console.warn("Could not start Firestore signaling listener:", err);
      }
    }
  }

  public stop() {
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }
    if (this.unsubscribeSignals) {
      this.unsubscribeSignals();
      this.unsubscribeSignals = null;
    }
    for (const [peerId, pc] of this.peerConnections.entries()) {
      pc.close();
      this.callbacks.onPeerDisconnected?.(peerId);
      this.callbacks.onPeerStateChange?.(peerId, "disconnected");
    }
    this.peerConnections.clear();
    this.dataChannels.clear();
    this.pendingCandidates.clear();
    this.incomingFiles.clear();
    this.processedSignalIds.clear();
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

  // Handle discovered peers in channel: determine who is offerer
  public syncPeers(remoteDeviceIds: string[]) {
    for (const remoteId of remoteDeviceIds) {
      if (remoteId === this.localDeviceId) continue;

      if (!this.peerConnections.has(remoteId)) {
        // Deterministic role: smaller lexicographical ID is the offerer
        const isOfferer = this.localDeviceId < remoteId;
        if (isOfferer) {
          this.initiateOffer(remoteId);
        }
      }
    }

    // Clean up peers that left
    for (const peerId of this.peerConnections.keys()) {
      if (!remoteDeviceIds.includes(peerId)) {
        this.closePeer(peerId);
      }
    }
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
        this.sendSignal(peerDeviceId, "candidate", event.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.callbacks.onPeerStateChange?.(peerDeviceId, "connected");
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.callbacks.onPeerStateChange?.(peerDeviceId, "disconnected");
        this.closePeer(peerDeviceId);
      }
    };

    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerDeviceId, event.channel);
    };

    return pc;
  }

  private setupDataChannel(peerDeviceId: string, channel: RTCDataChannel) {
    this.dataChannels.set(peerDeviceId, channel);
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      this.callbacks.onPeerConnected?.(peerDeviceId);
      this.callbacks.onPeerStateChange?.(peerDeviceId, "connected");
    };

    channel.onclose = () => {
      this.callbacks.onPeerDisconnected?.(peerDeviceId);
      this.callbacks.onPeerStateChange?.(peerDeviceId, "disconnected");
      this.dataChannels.delete(peerDeviceId);
    };

    channel.onerror = (err) => {
      console.warn(`DataChannel error with ${peerDeviceId}`, err);
    };

    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WebRTCMessage;
        this.handleIncomingMessage(peerDeviceId, msg);
      } catch (err) {
        console.warn("Could not parse incoming WebRTC message", err);
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
      await this.sendSignal(peerDeviceId, "offer", offer);
    } catch (err) {
      console.warn(`Error creating offer for ${peerDeviceId}:`, err);
    }
  }

  private async handleOffer(peerDeviceId: string, offer: RTCSessionDescriptionInit) {
    const pc = this.getOrCreatePeerConnection(peerDeviceId);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      this.drainPendingCandidates(peerDeviceId);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.sendSignal(peerDeviceId, "answer", answer);
    } catch (err) {
      console.warn(`Error handling offer from ${peerDeviceId}:`, err);
    }
  }

  private async handleAnswer(peerDeviceId: string, answer: RTCSessionDescriptionInit) {
    const pc = this.peerConnections.get(peerDeviceId);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      this.drainPendingCandidates(peerDeviceId);
    } catch (err) {
      console.warn(`Error handling answer from ${peerDeviceId}:`, err);
    }
  }

  private async handleCandidate(peerDeviceId: string, candidate: RTCIceCandidateInit) {
    const pc = this.peerConnections.get(peerDeviceId);
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn(`Error adding ICE candidate from ${peerDeviceId}:`, err);
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
          console.warn("Error adding drained candidate:", err);
        }
      }
      this.pendingCandidates.delete(peerDeviceId);
    }
  }

  private closePeer(peerDeviceId: string) {
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
  }

  private async sendSignal(
    recipientDeviceId: string,
    type: "offer" | "answer" | "candidate",
    data: RTCSessionDescriptionInit | RTCIceCandidateInit
  ) {
    // 1. BroadcastChannel (local tabs)
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          senderDeviceId: this.localDeviceId,
          recipientDeviceId,
          type,
          data,
        });
      } catch (err) {
        console.warn("BroadcastChannel postMessage error:", err);
      }
    }

    // 2. Cloud Firestore (remote/cross-device)
    if (this.db) {
      try {
        await addDoc(collection(this.db, "channels", this.channelCode, "signals"), {
          senderDeviceId: this.localDeviceId,
          recipientDeviceId,
          senderUid: this.localUid,
          type,
          data: JSON.stringify(data),
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        console.warn("Firestore signal send notice:", err);
      }
    }
  }

  // Send Text Note over WebRTC DataChannel
  public sendText(text: string, senderName: string, targetPeerId?: string): boolean {
    const msg: WebRTCMessage = {
      type: "text",
      id: "txt_" + Math.random().toString(36).substring(2, 10),
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

  // Send File with Chunking & Backpressure over WebRTC DataChannel
  public async sendFile(
    file: File,
    senderName: string,
    targetPeerId?: string,
    onProgress?: (percent: number) => void
  ): Promise<boolean> {
    const openChannels: RTCDataChannel[] = [];
    for (const [peerId, dc] of this.dataChannels.entries()) {
      if (targetPeerId && targetPeerId !== "all" && peerId !== targetPeerId) continue;
      if (dc.readyState === "open") openChannels.push(dc);
    }

    if (openChannels.length === 0) return false;

    const arrayBuffer = await file.arrayBuffer();
    const totalBytes = arrayBuffer.byteLength;
    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
    const transferId = "tr_" + Math.random().toString(36).substring(2, 10);

    // 1. Send file metadata header
    const metaMsg: WebRTCMessage = {
      type: "file-meta",
      transferId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      size: totalBytes,
      totalChunks,
      senderName,
    };
    const metaPayload = JSON.stringify(metaMsg);
    for (const dc of openChannels) dc.send(metaPayload);

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

      const chunkMsg: WebRTCMessage = {
        type: "file-chunk",
        transferId,
        chunkIndex: i,
        data: chunkData,
      };
      const chunkPayload = JSON.stringify(chunkMsg);

      for (const dc of openChannels) {
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

    // 3. Send completion notice
    const completeMsg: WebRTCMessage = { type: "file-complete", transferId };
    const completePayload = JSON.stringify(completeMsg);
    for (const dc of openChannels) dc.send(completePayload);

    return true;
  }

  // Handle incoming data packets
  private handleIncomingMessage(peerDeviceId: string, msg: WebRTCMessage) {
    if (msg.type === "text") {
      this.callbacks.onTextMessage?.({
        id: msg.id,
        text: msg.text,
        senderName: msg.senderName,
        timestamp: msg.timestamp,
        peerDeviceId,
      });
    } else if (msg.type === "file-meta") {
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
    } else if (msg.type === "file-complete") {
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
      } catch (err) {
        console.error("Error reassembling file Blob:", err);
      } finally {
        this.incomingFiles.delete(msg.transferId);
      }
    }
  }
}
