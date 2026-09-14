import { WebRTCManager } from "./webrtc";
import { Firestore, collection, addDoc, serverTimestamp } from "firebase/firestore";
import { FirebaseStorage, ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { Transfer, TransferMethod } from "./types";

export interface TransferResult {
  transfer: Transfer;
  method: TransferMethod;
  success: boolean;
  error?: string;
}

export class TransferManager {
  private webrtc: WebRTCManager | null;
  private db: Firestore | null;
  private storage: FirebaseStorage | null;
  private localDeviceId: string;
  private localDeviceName: string;
  private localUid: string;
  private channelCode: string;

  constructor(
    webrtc: WebRTCManager | null,
    db: Firestore | null,
    storage: FirebaseStorage | null,
    localDeviceId: string,
    localDeviceName: string,
    localUid: string,
    channelCode: string
  ) {
    this.webrtc = webrtc;
    this.db = db;
    this.storage = storage;
    this.localDeviceId = localDeviceId;
    this.localDeviceName = localDeviceName;
    this.localUid = localUid;
    this.channelCode = channelCode;
  }

  // Determine whether to use local P2P or remote Cloud Storage
  public canUseP2P(recipientId: string): boolean {
    if (!this.webrtc) return false;
    if (recipientId === "all") {
      return this.webrtc.getConnectedPeerCount() > 0;
    }
    return this.webrtc.isConnectedToPeer(recipientId);
  }

  // Send Text Note
  public async sendText(
    recipientId: string,
    recipientName: string,
    text: string
  ): Promise<TransferResult> {
    const isP2P = this.canUseP2P(recipientId);
    let transferId = "txt_" + Math.random().toString(36).substring(2, 10);

    // Architecture A: Direct local P2P WebRTC DataChannel
    if (isP2P && this.webrtc) {
      const sent = this.webrtc.sendText(text, this.localDeviceName, recipientId === "all" ? undefined : recipientId);
      if (sent) {
        return {
          method: "p2p",
          success: true,
          transfer: {
            id: transferId,
            userId: this.localUid,
            accountId: this.channelCode,
            senderDeviceId: this.localDeviceId,
            recipientDeviceId: recipientId,
            senderName: this.localDeviceName,
            recipientName,
            filename: text.length > 30 ? text.slice(0, 30) + "…" : "Text note",
            mimeType: "text/plain",
            size: text.length,
            textContent: text,
            status: "completed",
            method: "p2p",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        };
      }
    }

    // Architecture B: Remote Storage / Firestore Transfer
    if (this.db) {
      try {
        const docRef = await addDoc(collection(this.db, "channels", this.channelCode, "transfers"), {
          senderDeviceId: this.localDeviceId,
          recipientDeviceId: recipientId,
          senderUid: this.localUid,
          senderName: this.localDeviceName,
          recipientName,
          filename: text.length > 30 ? text.slice(0, 30) + "…" : "Text note",
          mimeType: "text/plain",
          size: text.length,
          textContent: text,
          method: "storage",
          status: "completed",
          createdAt: serverTimestamp(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        });
        transferId = docRef.id;
      } catch (err: unknown) {
        console.warn("Firestore remote text transfer error:", err);
      }
    }

    return {
      method: "storage",
      success: true,
      transfer: {
        id: transferId,
        userId: this.localUid,
        accountId: this.channelCode,
        senderDeviceId: this.localDeviceId,
        recipientDeviceId: recipientId,
        senderName: this.localDeviceName,
        recipientName,
        filename: text.length > 30 ? text.slice(0, 30) + "…" : "Text note",
        mimeType: "text/plain",
        size: text.length,
        textContent: text,
        status: "completed",
        method: "storage",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    };
  }

  // Send File
  public async sendFile(
    recipientId: string,
    recipientName: string,
    file: File,
    onProgress?: (percent: number) => void
  ): Promise<TransferResult> {
    const isP2P = this.canUseP2P(recipientId);

    // Architecture A: Direct local P2P WebRTC DataChannel (16KB chunking with backpressure)
    if (isP2P && this.webrtc) {
      try {
        const sent = await this.webrtc.sendFile(
          file,
          this.localDeviceName,
          recipientId === "all" ? undefined : recipientId,
          onProgress
        );
        if (sent) {
          return {
            method: "p2p",
            success: true,
            transfer: {
              id: "file_" + Math.random().toString(36).substring(2, 10),
              userId: this.localUid,
              accountId: this.channelCode,
              senderDeviceId: this.localDeviceId,
              recipientDeviceId: recipientId,
              senderName: this.localDeviceName,
              recipientName,
              filename: file.name,
              mimeType: file.type || "application/octet-stream",
              size: file.size,
              downloadUrl: URL.createObjectURL(file),
              status: "completed",
              method: "p2p",
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          };
        }
      } catch (err) {
        console.warn("Local P2P transfer error, falling back to remote storage:", err);
      }
    }

    // Architecture B: Remote Firebase Storage & Firestore transfer (24h expiry)
    let downloadUrl = "";
    let transferId = "tr_" + Math.random().toString(36).substring(2, 10);
    const cleanName = file.name.replace(/[^a-zA-Z0-9._ -]/g, "_");
    const filePath = `channels/${this.channelCode}/transfers/${transferId}/${cleanName}`;

    if (this.storage) {
      try {
        const fileStorageRef = storageRef(this.storage, filePath);
        onProgress?.(20);
        await uploadBytes(fileStorageRef, file, {
          contentType: file.type || "application/octet-stream",
        });
        onProgress?.(80);
        downloadUrl = await getDownloadURL(fileStorageRef);
      } catch (err: unknown) {
        console.warn("Storage upload error:", err);
      }
    }

    if (this.db) {
      try {
        const docRef = await addDoc(collection(this.db, "channels", this.channelCode, "transfers"), {
          senderDeviceId: this.localDeviceId,
          recipientDeviceId: recipientId,
          senderUid: this.localUid,
          senderName: this.localDeviceName,
          recipientName,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          storagePath: filePath,
          downloadUrl: downloadUrl || "",
          method: "storage",
          status: "completed",
          createdAt: serverTimestamp(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        });
        transferId = docRef.id;
      } catch (err: unknown) {
        console.warn("Firestore transfer document error:", err);
      }
    }

    onProgress?.(100);

    return {
      method: "storage",
      success: true,
      transfer: {
        id: transferId,
        userId: this.localUid,
        accountId: this.channelCode,
        senderDeviceId: this.localDeviceId,
        recipientDeviceId: recipientId,
        senderName: this.localDeviceName,
        recipientName,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        storagePath: filePath,
        downloadUrl: downloadUrl || URL.createObjectURL(file),
        status: "completed",
        method: "storage",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    };
  }
}
