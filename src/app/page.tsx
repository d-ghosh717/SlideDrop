"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { onAuthStateChanged, signInAnonymously, User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  Unsubscribe,
} from "firebase/firestore";
import { auth, db, storage } from "@/lib/firebase";
import { WebRTCManager } from "@/lib/webrtc";
import { TransferManager } from "@/lib/transfer-manager";
import type { Device, Transfer } from "@/lib/types";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const STORAGE_DEVICE_ID = "slidedrop-device-uuid";
const STORAGE_DEVICE_NAME = "slidedrop-device-name";
const STORAGE_CHANNEL_CODE = "slidedrop-channel-code";
const STORAGE_TRANSFERS = "slidedrop-transfers-history";

type AppConnectionStatus =
  | "INITIALIZING"
  | "AUTHENTICATING"
  | "WAITING_FOR_DEVICE"
  | "DEVICE_DISCOVERED"
  | "CONNECTING_PEER"
  | "PEER_CONNECTED"
  | "SECURE_RELAY"
  | "TRANSFERRING"
  | "FIREBASE_ERROR"
  | "DISCONNECTED";

function getDevicePlatform(): { type: "desktop" | "mobile" | "tablet" | "browser"; defaultName: string; icon: string } {
  if (typeof navigator === "undefined") {
    return { type: "desktop", defaultName: "Desktop", icon: "💻" };
  }
  const ua = navigator.userAgent;
  const isMobile = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isTablet = /iPad|Tablet/i.test(ua);
  const isMac = /Macintosh|Mac OS X/i.test(ua);
  const isWindows = /Windows NT/i.test(ua);
  const isLinux = /Linux/i.test(ua) && !isMobile;

  if (isTablet) return { type: "tablet", defaultName: "iPad", icon: "📱" };
  if (/iPhone/i.test(ua)) return { type: "mobile", defaultName: "iPhone", icon: "📱" };
  if (/Android/i.test(ua)) return { type: "mobile", defaultName: "Android Phone", icon: "📱" };
  if (isMac) return { type: "desktop", defaultName: "MacBook", icon: "💻" };
  if (isWindows) return { type: "desktop", defaultName: "Windows PC", icon: "🖥️" };
  if (isLinux) return { type: "desktop", defaultName: "Linux Desktop", icon: "🖥️" };
  if (isMobile) return { type: "mobile", defaultName: "Mobile Device", icon: "📱" };
  return { type: "desktop", defaultName: "Browser", icon: "🌐" };
}

function generateRandomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const randomBytes = new Uint8Array(6);
    crypto.getRandomValues(randomBytes);
    for (let i = 0; i < 6; i++) {
      result += chars[randomBytes[i] % chars.length];
    }
  } else {
    for (let i = 0; i < 6; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return result;
}

function generatePersistentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `dev_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `dev_${Math.random().toString(36).substring(2, 10)}`;
}

function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatTime(timestamp: unknown): string {
  if (!timestamp) return "Just now";
  let date: Date;
  if (timestamp instanceof Date) {
    date = timestamp;
  } else if (
    typeof timestamp === "object" &&
    timestamp !== null &&
    "toDate" in timestamp &&
    typeof (timestamp as { toDate: () => Date }).toDate === "function"
  ) {
    date = (timestamp as { toDate: () => Date }).toDate();
  } else if (typeof timestamp === "string" || typeof timestamp === "number") {
    date = new Date(timestamp);
  } else {
    return "Just now";
  }

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString();
}

export default function Home() {
  // 1. Local Device Identity
  const [deviceId] = useState<string>(() => {
    if (typeof window === "undefined") return "server-id";
    let stored = localStorage.getItem(STORAGE_DEVICE_ID);
    if (!stored) {
      stored = generatePersistentId();
      localStorage.setItem(STORAGE_DEVICE_ID, stored);
    }
    return stored;
  });

  const [deviceName, setDeviceName] = useState<string>(() => {
    if (typeof window === "undefined") return "My Device";
    let stored = localStorage.getItem(STORAGE_DEVICE_NAME);
    if (!stored) {
      stored = getDevicePlatform().defaultName;
      localStorage.setItem(STORAGE_DEVICE_NAME, stored);
    }
    return stored;
  });

  // 2. Channel Code State
  const [channelCode, setChannelCode] = useState<string>(() => {
    if (typeof window === "undefined") return "YYXJ8C";
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("channel") || params.get("code") || params.get("join");
    if (fromUrl) {
      const normalized = fromUrl.trim().toUpperCase();
      localStorage.setItem(STORAGE_CHANNEL_CODE, normalized);
      return normalized;
    }
    let stored = localStorage.getItem(STORAGE_CHANNEL_CODE);
    if (!stored) {
      stored = generateRandomCode();
      localStorage.setItem(STORAGE_CHANNEL_CODE, stored);
    }
    return stored;
  });

  const [channelInput, setChannelInput] = useState("");
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(deviceName);

  // 3. Remote Channel Members (Authoritative State from Network)
  const [remoteMembers, setRemoteMembers] = useState<Map<string, Device>>(new Map());
  const [peerStates, setPeerStates] = useState<Map<string, "connecting" | "connected" | "disconnected">>(new Map());

  // 4. Firebase Auth & Status
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // 5. Transfers & Composer States
  const [transfers, setTransfers] = useState<Transfer[]>(() => {
    if (typeof window === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_TRANSFERS);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as Transfer[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const [recipient, setRecipient] = useState<string>("all");
  const [textMessage, setTextMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [transferProgress, setTransferProgress] = useState<number | null>(null);
  const [transferStatusText, setTransferStatusText] = useState<string>("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; type: "success" | "warning" | "info" } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const transferManagerRef = useRef<TransferManager | null>(null);

  // Append transfer helper
  const appendTransfer = useCallback((transfer: Transfer) => {
    setTransfers((prev) => {
      if (prev.some((t) => t.id === transfer.id)) return prev;
      const next = [transfer, ...prev];
      localStorage.setItem(STORAGE_TRANSFERS, JSON.stringify(next));
      return next;
    });
  }, []);

  // 1. Firebase Authentication Lifecycle
  useEffect(() => {
    if (!auth) return;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user);
        setAuthError(null);
      } else {
        try {
          const cred = await signInAnonymously(auth);
          setCurrentUser(cred.user);
          setAuthError(null);
        } catch (err: unknown) {
          const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unknown";
          setAuthError(code);
          setErrorMessage(`Firebase Auth notice (${code}).`);
        }
      }
    });

    return () => unsubscribe();
  }, []);

  // 2. WebRTC Manager Lifecycle
  useEffect(() => {
    if (typeof window === "undefined") return;

    const callbacks = {
      onPeerConnected: (peerId: string) => {
        setPeerStates((prev) => new Map(prev).set(peerId, "connected"));
        setNotice({ text: "🟢 Direct WebRTC P2P DataChannel established!", type: "success" });
      },
      onPeerDisconnected: (peerId: string) => {
        setPeerStates((prev) => {
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
      },
      onPeerStateChange: (peerId: string, state: "connecting" | "connected" | "disconnected") => {
        setPeerStates((prev) => new Map(prev).set(peerId, state));
      },
      onTextMessage: (msg: { id: string; text: string; senderName: string; timestamp: number; peerDeviceId: string }) => {
        const transfer: Transfer = {
          id: msg.id,
          userId: msg.peerDeviceId,
          accountId: channelCode,
          senderDeviceId: msg.peerDeviceId,
          recipientDeviceId: deviceId,
          senderName: msg.senderName,
          recipientName: deviceName,
          filename: msg.text.length > 30 ? msg.text.slice(0, 30) + "…" : "Text note",
          mimeType: "text/plain",
          size: msg.text.length,
          textContent: msg.text,
          status: "completed",
          method: "p2p",
          createdAt: new Date(msg.timestamp).toISOString(),
          expiresAt: new Date(msg.timestamp + 86400000).toISOString(),
        };
        appendTransfer(transfer);
        setNotice({ text: `💬 Received note from ${msg.senderName}`, type: "success" });
      },
      onFileProgress: (transferId: string, percent: number, direction: "send" | "receive") => {
        setTransferProgress(percent);
        setTransferStatusText(direction === "send" ? `Sending file (${percent}%)...` : `Receiving file (${percent}%)...`);
        if (percent >= 100) {
          setTimeout(() => {
            setTransferProgress(null);
            setTransferStatusText("");
          }, 1200);
        }
      },
      onFileReceived: (fileTransfer: {
        id: string;
        filename: string;
        mimeType: string;
        size: number;
        downloadUrl: string;
        senderName: string;
        timestamp: number;
      }) => {
        const transfer: Transfer = {
          id: fileTransfer.id,
          userId: "peer",
          accountId: channelCode,
          senderDeviceId: "peer",
          recipientDeviceId: deviceId,
          senderName: fileTransfer.senderName,
          recipientName: deviceName,
          filename: fileTransfer.filename,
          mimeType: fileTransfer.mimeType,
          size: fileTransfer.size,
          downloadUrl: fileTransfer.downloadUrl,
          status: "completed",
          method: "p2p",
          createdAt: new Date(fileTransfer.timestamp).toISOString(),
          expiresAt: new Date(fileTransfer.timestamp + 86400000).toISOString(),
        };
        appendTransfer(transfer);
        setNotice({ text: `📁 Received "${fileTransfer.filename}" from ${fileTransfer.senderName}!`, type: "success" });
      },
    };

    const mgr = new WebRTCManager(db, deviceId, currentUser?.uid || "anon-user", channelCode, callbacks);
    mgr.startSignaling();
    webrtcRef.current = mgr;

    transferManagerRef.current = new TransferManager(
      mgr,
      db,
      storage,
      deviceId,
      deviceName,
      currentUser?.uid || "anon-user",
      channelCode
    );

    return () => {
      mgr.stop();
      webrtcRef.current = null;
      transferManagerRef.current = null;
    };
  }, [currentUser, channelCode, deviceId, deviceName, appendTransfer]);

  // 3. Presence: Register Self and Discover Channel Members (Firestore + BroadcastChannel)
  useEffect(() => {
    const platform = getDevicePlatform();
    const selfDevice: Device = {
      id: deviceId,
      userId: currentUser?.uid || "anon-user",
      accountId: channelCode,
      name: deviceName,
      type: platform.type,
      pairingCode: channelCode,
      online: true,
      state: "ONLINE",
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };

    // A. Local BroadcastChannel for instant same-browser presence
    let localBroadcast: BroadcastChannel | null = null;
    if (typeof window !== "undefined" && "BroadcastChannel" in window) {
      try {
        localBroadcast = new BroadcastChannel(`slidedrop_presence_${channelCode}`);
        localBroadcast.onmessage = (event) => {
          const { type, device } = event.data || {};
          if (type === "heartbeat" && device && device.id !== deviceId) {
            setRemoteMembers((prev) => {
              const next = new Map(prev);
              next.set(device.id, {
                ...device,
                state: "ONLINE",
                online: true,
                lastSeen: Date.now(),
              });
              return next;
            });
          } else if (type === "leave" && device) {
            setRemoteMembers((prev) => {
              const next = new Map(prev);
              next.delete(device.id);
              return next;
            });
          }
        };

        localBroadcast.postMessage({ type: "heartbeat", device: selfDevice });
      } catch (err) {
        console.warn("Local broadcast error:", err);
      }
    }

    // B. Cloud Firestore Presence
    let unsubFirestore: Unsubscribe | null = null;
    let heartbeatTimer: number | null = null;

    if (db) {
      const deviceDocRef = doc(db, "channels", channelCode, "devices", deviceId);

      const sendHeartbeat = () => {
        setDoc(
          deviceDocRef,
          {
            deviceId,
            deviceName,
            platform: platform.type,
            uid: currentUser?.uid || "anon-user",
            lastSeen: serverTimestamp(),
            online: true,
          },
          { merge: true }
        ).catch((err) => {
          console.warn("Firestore presence notice:", err.message);
        });

        if (localBroadcast) {
          localBroadcast.postMessage({
            type: "heartbeat",
            device: selfDevice,
          });
        }
      };

      sendHeartbeat();
      heartbeatTimer = window.setInterval(sendHeartbeat, 4000);

      // Listen for remote channel members
      try {
        const devicesRef = collection(db, "channels", channelCode, "devices");
        unsubFirestore = onSnapshot(
          devicesRef,
          (snapshot) => {
            setRemoteMembers((prev) => {
              const next = new Map(prev);

              snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                const dId = data.deviceId || docSnap.id;
                if (dId === deviceId) return;

                next.set(dId, {
                  id: dId,
                  userId: data.uid || "anon",
                  accountId: channelCode,
                  name: data.deviceName || "Device",
                  type: data.platform || "browser",
                  pairingCode: channelCode,
                  online: data.online !== false,
                  state: "ONLINE",
                  lastSeen: data.lastSeen,
                  createdAt: data.lastSeen,
                });
              });

              return next;
            });
          },
          (error) => {
            console.warn("Firestore devices onSnapshot notice:", error.message);
          }
        );
      } catch (err) {
        console.warn("Firestore onSnapshot attach notice:", err);
      }
    }

    // C. Prune stale devices every 5 seconds
    const pruneInterval = window.setInterval(() => {
      const now = Date.now();
      setRemoteMembers((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, dev] of next.entries()) {
          let seenMs = 0;
          if (typeof dev.lastSeen === "number") {
            seenMs = dev.lastSeen;
          } else if (
            dev.lastSeen &&
            typeof dev.lastSeen === "object" &&
            "toMillis" in dev.lastSeen &&
            typeof (dev.lastSeen as { toMillis: () => number }).toMillis === "function"
          ) {
            seenMs = (dev.lastSeen as { toMillis: () => number }).toMillis();
          }
          if (seenMs > 0 && now - seenMs > 12000) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5000);

    return () => {
      clearInterval(pruneInterval);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (localBroadcast) {
        localBroadcast.postMessage({ type: "leave", device: selfDevice });
        localBroadcast.close();
      }
      if (unsubFirestore) unsubFirestore();
      if (db) {
        deleteDoc(doc(db, "channels", channelCode, "devices", deviceId)).catch(() => {});
      }
    };
  }, [currentUser, channelCode, deviceId, deviceName]);

  // 4. Sync WebRTC Peers with Channel Members
  useEffect(() => {
    const remoteIds = Array.from(remoteMembers.keys());
    if (webrtcRef.current) {
      webrtcRef.current.syncPeers(remoteIds);
    }
  }, [remoteMembers]);

  // 5. Cloud Firestore Fallback Transfers Listener (Architecture B)
  useEffect(() => {
    if (!db || !currentUser) return;

    const transfersRef = collection(db, "channels", channelCode, "transfers");
    const q = query(transfersRef, where("recipientDeviceId", "in", ["all", deviceId]));

    let unsubTransfers: Unsubscribe | null = null;
    try {
      unsubTransfers = onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added") {
            const data = change.doc.data();
            if (data.senderDeviceId !== deviceId) {
              const transfer: Transfer = {
                id: change.doc.id,
                userId: data.senderUid || data.senderDeviceId,
                accountId: channelCode,
                senderDeviceId: data.senderDeviceId,
                recipientDeviceId: data.recipientDeviceId,
                senderName: data.senderName,
                recipientName: data.recipientName || deviceName,
                filename: data.filename,
                mimeType: data.mimeType,
                size: data.size,
                textContent: data.textContent,
                downloadUrl: data.downloadUrl,
                status: "completed",
                method: "storage",
                createdAt: data.createdAt ? formatTime(data.createdAt) : new Date().toISOString(),
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
              };
              appendTransfer(transfer);
              setNotice({
                text: `☁️ Received ${data.textContent ? "note" : `"${data.filename}"`} from ${data.senderName} via Cloud Relay!`,
                type: "success",
              });
            }
          }
        });
      });
    } catch (err) {
      console.warn("Firestore transfers listener notice:", err);
    }

    return () => {
      if (unsubTransfers) unsubTransfers();
    };
  }, [currentUser, channelCode, deviceId, deviceName, appendTransfer]);

  // Authoritative Derived Devices List
  const platformInfo = useMemo(() => getDevicePlatform(), []);

  const [sessionStartTime] = useState<number>(() => (typeof Date !== "undefined" ? Date.now() : 0));

  const selfDevice = useMemo<Device>(() => ({
    id: deviceId,
    userId: currentUser?.uid || "anon-user",
    accountId: channelCode,
    name: deviceName,
    type: platformInfo.type,
    pairingCode: channelCode,
    online: true,
    state: "ONLINE",
    lastSeen: sessionStartTime,
    createdAt: sessionStartTime,
  }), [deviceId, currentUser, channelCode, deviceName, platformInfo, sessionStartTime]);

  const otherDevices = useMemo(() => {
    return Array.from(remoteMembers.values()).filter((d) => d.id !== deviceId);
  }, [remoteMembers, deviceId]);

  const allDevices = useMemo(() => {
    return [selfDevice, ...otherDevices];
  }, [selfDevice, otherDevices]);

  const connectedPeerIds = useMemo(() => {
    const list: string[] = [];
    for (const [id, st] of peerStates.entries()) {
      if (st === "connected") list.push(id);
    }
    return list;
  }, [peerStates]);

  // Purely Derived Overall Status (No Synchronous Cascading setState)
  const currentStatus: AppConnectionStatus = useMemo(() => {
    if (authError) return "FIREBASE_ERROR";
    if (transferProgress !== null && transferProgress > 0 && transferProgress < 100) return "TRANSFERRING";
    if (connectedPeerIds.length > 0) return "PEER_CONNECTED";
    if (otherDevices.length > 0) {
      const isAnyConnecting = Array.from(peerStates.values()).some((s) => s === "connecting");
      return isAnyConnecting ? "CONNECTING_PEER" : "DEVICE_DISCOVERED";
    }
    if (!currentUser) return "AUTHENTICATING";
    return "WAITING_FOR_DEVICE";
  }, [authError, transferProgress, connectedPeerIds, otherDevices, peerStates, currentUser]);

  // Rename Device Handler
  const handleSaveName = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setNotice({ text: "Device name cannot be empty.", type: "warning" });
      return;
    }
    setDeviceName(trimmed);
    localStorage.setItem(STORAGE_DEVICE_NAME, trimmed);
    setIsEditingName(false);

    if (db) {
      try {
        await updateDoc(doc(db, "channels", channelCode, "devices", deviceId), {
          deviceName: trimmed,
          lastSeen: serverTimestamp(),
        });
      } catch (err) {
        console.warn("Firestore rename notice:", err);
      }
    }
    setNotice({ text: `Device renamed to "${trimmed}"`, type: "success" });
  };

  // Join Channel Handler
  const handleJoinChannel = (targetCode?: string) => {
    const raw = targetCode || channelInput;
    const code = raw.trim().toUpperCase();
    if (!code) {
      setNotice({ text: "Please enter a 6-character channel code.", type: "warning" });
      return;
    }

    if (code === channelCode) {
      setNotice({ text: `Already in channel ${code}`, type: "info" });
      setChannelInput("");
      return;
    }

    if (db) {
      deleteDoc(doc(db, "channels", channelCode, "devices", deviceId)).catch(() => {});
    }

    setChannelCode(code);
    localStorage.setItem(STORAGE_CHANNEL_CODE, code);
    setChannelInput("");
    setRemoteMembers(new Map());
    setPeerStates(new Map());
    setNotice({ text: `Joined channel ${code}! Discovering devices...`, type: "success" });
  };

  // Send Text Note via TransferManager
  const handleSendText = async () => {
    const text = textMessage.trim();
    if (!text) {
      setNotice({ text: "Please enter a message to send.", type: "warning" });
      return;
    }

    const recipientDevice = otherDevices.find((d) => d.id === recipient);
    const targetRecipientName = recipient === "all" ? "All Devices" : recipientDevice?.name || "Peer";

    if (!transferManagerRef.current) return;

    setTransferStatusText("Sending note...");
    const result = await transferManagerRef.current.sendText(recipient, targetRecipientName, text);

    if (result.success) {
      appendTransfer(result.transfer);
      setTextMessage("");
      setTransferStatusText("");
      setNotice({
        text: result.method === "p2p" ? "💬 Note sent directly via WebRTC P2P!" : "☁️ Note sent via Cloud Relay!",
        type: "success",
      });
    }
  };

  // Send File via TransferManager
  const handleSendFile = async () => {
    if (!selectedFile) {
      setNotice({ text: "Please select or drop a file to send.", type: "warning" });
      return;
    }

    const recipientDevice = otherDevices.find((d) => d.id === recipient);
    const targetRecipientName = recipient === "all" ? "All Devices" : recipientDevice?.name || "Peer";

    if (!transferManagerRef.current) return;

    setTransferStatusText("Preparing file for transfer...");
    setTransferProgress(0);

    const result = await transferManagerRef.current.sendFile(
      recipient,
      targetRecipientName,
      selectedFile,
      (percent) => {
        setTransferProgress(percent);
        setTransferStatusText(`Transferring "${selectedFile.name}" (${percent}%)...`);
      }
    );

    if (result.success) {
      appendTransfer(result.transfer);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setTransferProgress(null);
      setTransferStatusText("");
      setNotice({
        text: result.method === "p2p" ? `📁 "${selectedFile.name}" sent via WebRTC P2P!` : `☁️ "${selectedFile.name}" uploaded to Cloud Relay!`,
        type: "success",
      });
    }
  };

  // Action Helpers
  const handleTransferAction = async (transfer: Transfer) => {
    if (transfer.textContent) {
      try {
        await navigator.clipboard.writeText(transfer.textContent);
        setCopiedId(transfer.id);
        setNotice({ text: "Text copied to clipboard!", type: "success" });
        setTimeout(() => setCopiedId(null), 2000);
      } catch {
        setNotice({ text: transfer.textContent, type: "info" });
      }
      return;
    }

    const targetUrl = transfer.downloadUrl || transfer.fileData;
    if (targetUrl) {
      const anchor = document.createElement("a");
      anchor.href = targetUrl;
      anchor.download = transfer.filename || "file";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setNotice({ text: `Downloading "${transfer.filename}"...`, type: "success" });
    }
  };

  const copyShareLink = () => {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}?channel=${channelCode}`;
    navigator.clipboard.writeText(url);
    setNotice({ text: "Channel invite link copied! Open on other devices to connect.", type: "success" });
  };

  const copyChannelCode = () => {
    navigator.clipboard.writeText(channelCode);
    setNotice({ text: `Channel code ${channelCode} copied!`, type: "success" });
  };

  const clearHistory = () => {
    setTransfers([]);
    localStorage.removeItem(STORAGE_TRANSFERS);
    setNotice({ text: "Transfer history cleared.", type: "info" });
  };

  const deleteTransfer = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = transfers.filter((t) => t.id !== id);
    setTransfers(updated);
    localStorage.setItem(STORAGE_TRANSFERS, JSON.stringify(updated));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = () => {
    setIsDragging(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setSelectedFile(e.dataTransfer.files[0]);
    }
  };

  return (
    <main className={styles.container}>
      <div className={styles.shell}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.brand}>
            <div className={styles.logoIcon}>⚡</div>
            <div>
              <h1 className={styles.brandTitle}>SlideDrop</h1>
              <p className={styles.brandSubtitle}>Direct P2P & Cloud Cross-Device Transfer</p>
            </div>
          </div>

          <div className={styles.headerActions}>
            <div
              className={`${styles.statusBadge} ${
                currentStatus === "PEER_CONNECTED"
                  ? styles.statusP2P
                  : currentStatus === "TRANSFERRING"
                  ? styles.statusConnecting
                  : currentStatus === "DEVICE_DISCOVERED" || currentStatus === "CONNECTING_PEER"
                  ? styles.statusConnecting
                  : currentStatus === "WAITING_FOR_DEVICE"
                  ? styles.statusWaiting
                  : styles.statusDisconnected
              }`}
              onClick={() => setShowDiagnostics(true)}
              style={{ cursor: "pointer" }}
              title="Click to view connection diagnostics"
            >
              <span className={styles.statusDot} />
              {currentStatus === "PEER_CONNECTED"
                ? `🟢 P2P Connected (${connectedPeerIds.length} peer${connectedPeerIds.length > 1 ? "s" : ""})`
                : currentStatus === "TRANSFERRING"
                ? `⚡ Transferring (${transferProgress || 0}%)`
                : currentStatus === "CONNECTING_PEER"
                ? "Connecting P2P…"
                : currentStatus === "DEVICE_DISCOVERED"
                ? `🟢 Device Found (${otherDevices.length})`
                : currentStatus === "WAITING_FOR_DEVICE"
                ? `Waiting for device (${channelCode})`
                : currentStatus === "AUTHENTICATING"
                ? "Connecting Firebase…"
                : "Firebase Notice"}
            </div>

            <button className={styles.secondaryBtn} onClick={copyShareLink}>
              🔗 Share Link
            </button>
          </div>
        </header>

        {/* Notice & Error Banner */}
        {errorMessage && (
          <div className={`${styles.noticeBanner} ${styles.noticeWarning}`}>
            <span>⚠️ {errorMessage}</span>
            <button className={styles.noticeClose} onClick={() => setErrorMessage(null)}>
              ✕
            </button>
          </div>
        )}

        {notice && (
          <div
            className={`${styles.noticeBanner} ${
              notice.type === "warning"
                ? styles.noticeWarning
                : notice.type === "info"
                ? styles.noticeInfo
                : ""
            }`}
          >
            <span>{notice.text}</span>
            <button className={styles.noticeClose} onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        )}

        {/* Connected Devices & Channel Toolbar */}
        <section className={styles.deviceCard}>
          <div className={styles.deviceCardHeader}>
            <h2 className={styles.sectionTitle}>
              <span>Connected Devices ({allDevices.length})</span>
            </h2>

            <div className={styles.pairingBox}>
              <div className={styles.pairingCodePill} title="Share this channel code with other devices">
                <span className={styles.pairingCodeLabel}>Channel:</span>
                <span>{channelCode}</span>
                <button
                  className={styles.secondaryBtn}
                  style={{ padding: "3px 8px", fontSize: "11px" }}
                  onClick={copyChannelCode}
                >
                  Copy
                </button>
              </div>

              <input
                className={styles.inlineInput}
                style={{ width: "130px", minWidth: "110px", textTransform: "uppercase" }}
                placeholder="JOIN CODE"
                maxLength={8}
                value={channelInput}
                onChange={(e) => setChannelInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleJoinChannel()}
              />
              <button className={styles.secondaryBtn} onClick={() => handleJoinChannel()}>
                Join
              </button>
            </div>
          </div>

          {/* Device Grid */}
          <div className={styles.deviceGrid}>
            {/* Local Device */}
            <div className={`${styles.deviceItem} ${styles.deviceItemActive}`}>
              <div className={styles.deviceItemContent}>
                <div className={styles.deviceIcon}>{platformInfo.icon}</div>
                <div className={styles.deviceMeta}>
                  <p className={styles.deviceName}>{deviceName}</p>
                  <p className={styles.deviceSub}>
                    <span className={styles.onlineIndicator} />
                    {platformInfo.type}
                    <span className={styles.thisDeviceTag}>This Device</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Remote Channel Members */}
            {otherDevices.map((remote) => {
              const peerState = peerStates.get(remote.id);
              const isP2P = peerState === "connected";
              const isConnecting = peerState === "connecting";

              const icon =
                remote.type === "mobile"
                  ? "📱"
                  : remote.type === "tablet"
                  ? "📱"
                  : remote.type === "browser"
                  ? "🌐"
                  : "💻";

              return (
                <div
                  key={remote.id}
                  className={`${styles.deviceItem} ${recipient === remote.id ? styles.deviceItemActive : ""}`}
                  onClick={() => setRecipient(remote.id)}
                  title={`Click to send directly to ${remote.name}`}
                >
                  <div className={styles.deviceItemContent}>
                    <div className={styles.deviceIcon}>{icon}</div>
                    <div className={styles.deviceMeta}>
                      <p className={styles.deviceName}>{remote.name}</p>
                      <p className={styles.deviceSub}>
                        <span className={styles.onlineIndicator} />
                        {isP2P ? "🟢 P2P Direct" : isConnecting ? "🟡 Connecting P2P" : "🟢 Online (Relay)"}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Device Controls */}
          <div className={styles.deviceControls}>
            <div className={styles.nameSettingGroup}>
              {isEditingName ? (
                <>
                  <input
                    className={styles.inlineInput}
                    placeholder="Enter device name (e.g. MacBook)"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveName()}
                    autoFocus
                  />
                  <button className={styles.primaryBtn} onClick={handleSaveName}>
                    Save Name
                  </button>
                  <button
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setIsEditingName(false);
                      setNameInput(deviceName);
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: "14px", fontWeight: 600, color: "#334155" }}>
                    Device Name: <strong style={{ color: "#0f172a" }}>{deviceName}</strong>
                  </span>
                  <button
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setNameInput(deviceName);
                      setIsEditingName(true);
                    }}
                  >
                    ✏️ Rename
                  </button>
                </>
              )}
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <span style={{ fontSize: "12px", color: "#64748b" }}>
                Device ID: <code>{deviceId.slice(0, 8)}</code>
              </span>
            </div>
          </div>
        </section>

        {/* Main 2-Column Grid */}
        <div className={styles.mainGrid}>
          {/* Send Something Panel */}
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>
              <span>📤 Send to Devices</span>
            </h2>

            {/* Recipient Selector (Unified Authoritative Source) */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>
                <span>Send To</span>
                <span className={styles.fieldHint}>
                  {recipient === "all"
                    ? `Broadcasting to channel (${otherDevices.length} recipient${otherDevices.length === 1 ? "" : "s"})`
                    : "Direct to selected device"}
                </span>
              </label>
              <select
                className={styles.selectInput}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              >
                <option value="all">📢 All Devices in Channel ({otherDevices.length})</option>
                {otherDevices.map((d) => {
                  const isP2P = peerStates.get(d.id) === "connected";
                  return (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.type}) {isP2P ? "⚡ P2P Direct" : "☁️ Cloud Relay"}
                    </option>
                  );
                })}
              </select>
            </div>

            {/* Quick Note Transfer */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>
                <span>Quick Note / Text</span>
                <span className={styles.fieldHint}>{textMessage.length} chars</span>
              </label>
              <textarea
                className={styles.textareaInput}
                placeholder="Type a message, paste a link, code snippet, or note to send instantly..."
                value={textMessage}
                onChange={(e) => setTextMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    handleSendText();
                  }
                }}
              />
              <button
                className={`${styles.primaryBtn} ${styles.sendBtn}`}
                disabled={!textMessage.trim()}
                onClick={handleSendText}
              >
                💬 Send Text Note
              </button>
            </div>

            <div className={styles.divider}>or transfer a file</div>

            {/* File Transfer */}
            <div className={styles.fieldGroup}>
              <div
                className={`${styles.dropzone} ${isDragging ? styles.dropzoneActive : ""}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className={styles.dropzoneIcon}>📁</div>
                <p className={styles.dropzoneText}>
                  {selectedFile ? "Click or drag to replace file" : "Drop files here or click to browse"}
                </p>
                <p className={styles.dropzoneSub}>Supports PDFs, images, docs, videos up to 250MB</p>
                <input
                  type="file"
                  ref={fileInputRef}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      setSelectedFile(e.target.files[0]);
                    }
                  }}
                />
              </div>

              {selectedFile && (
                <div className={styles.fileSelectedBox}>
                  <div className={styles.fileSelectedInfo}>
                    <span>📄</span>
                    <div>
                      <p className={styles.fileSelectedName}>{selectedFile.name}</p>
                      <p className={styles.fileSelectedSize}>{formatBytes(selectedFile.size)}</p>
                    </div>
                  </div>
                  <button
                    className={styles.removeFileBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}

              {transferProgress !== null && (
                <div className={styles.progressContainer}>
                  <div className={styles.progressBarBg}>
                    <div className={styles.progressBarFill} style={{ width: `${transferProgress}%` }} />
                  </div>
                  <span className={styles.progressText}>{transferStatusText}</span>
                </div>
              )}

              <button
                className={`${styles.primaryBtn} ${styles.sendBtn}`}
                disabled={!selectedFile || (transferProgress !== null && transferProgress > 0 && transferProgress < 100)}
                onClick={handleSendFile}
              >
                🚀 Send File
              </button>
            </div>
          </section>

          {/* Transfer History Panel */}
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>
                <span>📥 Transfer History ({transfers.length})</span>
              </h2>
              {transfers.length > 0 && (
                <button className={styles.clearBtn} onClick={clearHistory}>
                  Clear All
                </button>
              )}
            </div>

            {transfers.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>📭</div>
                <p className={styles.emptyTitle}>No transfers yet</p>
                <p className={styles.emptySubtitle}>
                  Sent and received files, links, and text notes will appear here in real-time.
                </p>
              </div>
            ) : (
              <div className={styles.transferList}>
                {transfers.map((item) => {
                  const isSentByMe = item.senderDeviceId === deviceId;
                  const isText = Boolean(item.textContent);

                  return (
                    <div
                      key={item.id}
                      className={styles.transferItem}
                      onClick={() => handleTransferAction(item)}
                      title={isText ? "Click to copy text note" : "Click to download file"}
                    >
                      <div className={styles.transferIcon}>{isText ? "💬" : "📄"}</div>
                      <div className={styles.transferDetails}>
                        <div className={styles.transferHeader}>
                          <p className={styles.transferFilename}>{item.filename}</p>
                          <span
                            className={`${styles.methodBadge} ${
                              item.method === "p2p" ? styles.methodP2P : styles.methodStorage
                            }`}
                          >
                            {item.method === "p2p" ? "⚡ P2P Direct" : "☁️ Cloud Relay"}
                          </span>
                        </div>

                        {item.textContent && (
                          <p className={styles.transferSnippet}>
                            {item.textContent.length > 90
                              ? item.textContent.slice(0, 90) + "…"
                              : item.textContent}
                          </p>
                        )}

                        <div className={styles.transferMeta}>
                          <span>
                            {isSentByMe ? `To: ${item.recipientName}` : `From: ${item.senderName}`}
                          </span>
                          <span>•</span>
                          <span>{formatBytes(item.size)}</span>
                          <span>•</span>
                          <span>{formatTime(item.createdAt)}</span>
                        </div>
                      </div>

                      <div className={styles.transferActions}>
                        <button
                          className={styles.actionBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTransferAction(item);
                          }}
                        >
                          {copiedId === item.id ? "✓ Copied" : isText ? "📋 Copy" : "⬇️ Download"}
                        </button>
                        <button
                          className={styles.deleteBtn}
                          onClick={(e) => deleteTransfer(item.id, e)}
                          title="Delete"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Connection Diagnostics Modal */}
        {showDiagnostics && (
          <div className={styles.modalOverlay} onClick={() => setShowDiagnostics(false)}>
            <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHeader}>
                <h3 className={styles.modalTitle}>⚡ SlideDrop Diagnostics</h3>
                <button className={styles.modalCloseBtn} onClick={() => setShowDiagnostics(false)}>
                  ✕
                </button>
              </div>

              <div className={styles.diagnosticsContent}>
                <div className={styles.diagRow}>
                  <span>Channel Code:</span>
                  <strong>{channelCode}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Local Device:</span>
                  <strong>{deviceName} (<code>{deviceId.slice(0, 8)}</code>)</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Auth Status:</span>
                  <strong>{currentUser ? `Authenticated (${currentUser.uid.slice(0, 8)})` : "Connecting..."}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Channel Members:</span>
                  <strong>{allDevices.length} total ({otherDevices.length} remote)</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Direct WebRTC Peers:</span>
                  <strong>{connectedPeerIds.length} active</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Active Architecture:</span>
                  <strong>{connectedPeerIds.length > 0 ? "⚡ Architecture A (Direct P2P)" : "☁️ Architecture B (Cloud Relay)"}</strong>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
