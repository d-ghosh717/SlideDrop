"use client";

import { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { onAuthStateChanged, signInAnonymously, User } from "firebase/auth";
import {
  collection,
  onSnapshot,
  query,
  where,
  Unsubscribe,
} from "firebase/firestore";
import { auth, db, storage } from "@/lib/firebase";
import { SignalingClient, getDefaultSignalingUrl } from "@/lib/signaling-client";
import type { SignalingEvent } from "@/lib/signaling-client";
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
  | "NOT_CONNECTED"
  | "CONNECTING_TO_SERVER"
  | "CHANNEL_JOINED"
  | "DEVICE_DISCOVERED"
  | "CONNECTING_PEER"
  | "P2P_CONNECTED"
  | "TRANSFERRING"
  | "OFFLINE"
  | "ERROR";

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

const subscribeNoop = () => () => {};
function useIsMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false
  );
}

function getInitialDeviceId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(STORAGE_DEVICE_ID);
  if (!id) {
    id = generatePersistentId();
    localStorage.setItem(STORAGE_DEVICE_ID, id);
  }
  return id;
}

function getInitialDeviceName(): string {
  if (typeof window === "undefined") return "My Device";
  let name = localStorage.getItem(STORAGE_DEVICE_NAME);
  if (!name) {
    name = getDevicePlatform().defaultName;
    localStorage.setItem(STORAGE_DEVICE_NAME, name);
  }
  return name;
}

function getInitialChannelCode(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("channel") || params.get("code") || params.get("join");
  if (fromUrl) {
    const norm = fromUrl.trim().toUpperCase();
    localStorage.setItem(STORAGE_CHANNEL_CODE, norm);
    return norm;
  }
  let stored = localStorage.getItem(STORAGE_CHANNEL_CODE);
  if (!stored) {
    stored = generateRandomCode();
    localStorage.setItem(STORAGE_CHANNEL_CODE, stored);
  }
  return stored;
}

function getInitialTransfers(): Transfer[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_TRANSFERS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function Home() {
  // 1. Hydration Mount Guard (Guarantees zero SSR mismatch)
  const isMounted = useIsMounted();

  // 2. Client-only Identity and Channel State (Lazily initialized)
  const [deviceId] = useState<string>(getInitialDeviceId);
  const [deviceName, setDeviceName] = useState<string>(getInitialDeviceName);
  const [channelCode, setChannelCode] = useState<string>(getInitialChannelCode);
  const [channelInput, setChannelInput] = useState("");
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(() => getInitialDeviceName());

  // 3. WebSocket Signaling & Peer Presence States
  const [isWsConnected, setIsWsConnected] = useState(false);
  const [remoteMembers, setRemoteMembers] = useState<Map<string, Device>>(new Map());
  const [peerStates, setPeerStates] = useState<Map<string, "connecting" | "connected" | "disconnected">>(new Map());

  // 4. Firebase Auth State (For cloud fallback)
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // 5. Transfer History & Composer States
  const [transfers, setTransfers] = useState<Transfer[]>(getInitialTransfers);
  const [recipient, setRecipient] = useState<string>("all");
  const [textMessage, setTextMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [transferProgress, setTransferProgress] = useState<number | null>(null);
  const [transferStatusText, setTransferStatusText] = useState<string>("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; type: "success" | "warning" | "info" } | null>(null);
  const [signalingEvents, setSignalingEvents] = useState<SignalingEvent[]>([]);
  const [signalingUrl, setSignalingUrl] = useState<string>(() => (typeof window !== "undefined" ? getDefaultSignalingUrl() : ""));

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const transferManagerRef = useRef<TransferManager | null>(null);

  // Append transfer helper
  const appendTransfer = useCallback((transfer: Transfer) => {
    setTransfers((prev) => {
      if (prev.some((t) => t.id === transfer.id)) return prev;
      const next = [transfer, ...prev];
      if (typeof window !== "undefined") {
        localStorage.setItem(STORAGE_TRANSFERS, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  // Firebase Anonymous Auth (for Architecture B cloud fallback)
  useEffect(() => {
    if (!auth) return;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user);
      } else {
        try {
          const cred = await signInAnonymously(auth);
          setCurrentUser(cred.user);
        } catch (err: unknown) {
          console.warn("[Firebase] Anonymous auth notice:", err);
        }
      }
    });

    return () => unsubscribe();
  }, []);

  // Initialize WebSocket Signaling Client & WebRTC Manager
  useEffect(() => {
    if (!isMounted || !deviceId || !channelCode) return;

    const platform = getDevicePlatform();

    // 1. Instantiate WebRTC Manager
    let webrtc: WebRTCManager | null = null;

    const webrtcCallbacks = {
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
      onTransferAcknowledged: (transferId: string) => {
        console.log(`[WebRTC] Transfer ${transferId} acknowledged by recipient.`);
      },
    };

    // 2. Instantiate Signaling Client
    const signaling = new SignalingClient({
      onConnected: () => {
        setIsWsConnected(true);
        setSignalingUrl(signaling.getUrl());
      },
      onDisconnected: () => {
        setIsWsConnected(false);
      },
      onJoined: (data) => {
        console.log("[Signaling] Successfully joined channel", data.channelCode, "with devices:", data.devices);
        const map = new Map<string, Device>();
        for (const dev of data.devices) {
          map.set(dev.id, dev);
        }
        setRemoteMembers(map);
      },
      onDeviceJoined: (device) => {
        console.log("[Signaling] New device joined:", device.name, device.id);
        setRemoteMembers((prev) => {
          const next = new Map(prev);
          next.set(device.id, device);
          return next;
        });
        setNotice({ text: `🟢 ${device.name} joined the channel!`, type: "info" });
      },
      onDeviceUpdated: (device) => {
        setRemoteMembers((prev) => {
          const next = new Map(prev);
          next.set(device.id, device);
          return next;
        });
      },
      onDeviceLeft: (leftDeviceId) => {
        console.log("[Signaling] Device left:", leftDeviceId);
        setRemoteMembers((prev) => {
          const next = new Map(prev);
          next.delete(leftDeviceId);
          return next;
        });
        if (webrtc) {
          webrtc.closePeer(leftDeviceId);
        }
      },
      onOffer: (data) => {
        if (webrtc) {
          webrtc.handleRemoteOffer(data.fromDeviceId, data.sdp);
        }
      },
      onAnswer: (data) => {
        if (webrtc) {
          webrtc.handleRemoteAnswer(data.fromDeviceId, data.sdp);
        }
      },
      onIceCandidate: (data) => {
        if (webrtc) {
          webrtc.handleRemoteIceCandidate(data.fromDeviceId, data.candidate);
        }
      },
      onError: (msg) => {
        setErrorMessage(msg);
      },
      onEvent: (event) => {
        setSignalingEvents((prev) => {
          const next = [event, ...prev];
          return next.length > 100 ? next.slice(0, 100) : next;
        });
      },
    });

    webrtc = new WebRTCManager(signaling, deviceId, deviceName, webrtcCallbacks);
    signalingRef.current = signaling;
    webrtcRef.current = webrtc;

    // Connect to WebSocket signaling server
    signaling.connect(channelCode, deviceId, deviceName, platform.type);

    // Initialize TransferManager (Dual Architectures A & B)
    transferManagerRef.current = new TransferManager(
      webrtc,
      db,
      storage,
      deviceId,
      deviceName,
      currentUser?.uid || "anon-user",
      channelCode
    );

    return () => {
      signaling.disconnect();
      webrtc?.closeAllPeers();
      signalingRef.current = null;
      webrtcRef.current = null;
      transferManagerRef.current = null;
    };
  }, [isMounted, deviceId, deviceName, channelCode, currentUser, appendTransfer]);

  // Synchronize WebRTC Peer connections whenever remote members change
  useEffect(() => {
    if (!webrtcRef.current) return;
    const remoteIds = Array.from(remoteMembers.keys()).filter((id) => id !== deviceId);
    webrtcRef.current.syncPeers(remoteIds);
  }, [remoteMembers, deviceId]);

  // Firestore Fallback Transfers Listener (Architecture B - 24h Expiry)
  useEffect(() => {
    if (!db || !currentUser || !channelCode || !deviceId) return;

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
      console.warn("[Firestore] Transfers listener notice:", err);
    }

    return () => {
      if (unsubTransfers) unsubTransfers();
    };
  }, [currentUser, channelCode, deviceId, deviceName, appendTransfer]);

  // Derived Channel Members & Recipient List (Authoritative)
  const platformInfo = useMemo(() => getDevicePlatform(), []);

  const selfDevice = useMemo<Device>(() => ({
    id: deviceId,
    userId: currentUser?.uid || "anon-user",
    accountId: channelCode,
    name: deviceName,
    type: platformInfo.type,
    pairingCode: channelCode,
    online: true,
    state: "ONLINE",
    lastSeen: 0,
    createdAt: 0,
  }), [deviceId, currentUser, channelCode, deviceName, platformInfo]);

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

  // Explicit Overall Connection State
  const currentStatus: AppConnectionStatus = useMemo(() => {
    if (!isWsConnected) return "CONNECTING_TO_SERVER";
    if (transferProgress !== null && transferProgress > 0 && transferProgress < 100) return "TRANSFERRING";
    if (connectedPeerIds.length > 0) return "P2P_CONNECTED";
    if (otherDevices.length > 0) {
      const isAnyConnecting = Array.from(peerStates.values()).some((s) => s === "connecting");
      return isAnyConnecting ? "CONNECTING_PEER" : "DEVICE_DISCOVERED";
    }
    return "CHANNEL_JOINED";
  }, [isWsConnected, transferProgress, connectedPeerIds, otherDevices, peerStates]);

  // Rename Device Handler
  const handleSaveName = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setNotice({ text: "Device name cannot be empty.", type: "warning" });
      return;
    }
    setDeviceName(trimmed);
    localStorage.setItem(STORAGE_DEVICE_NAME, trimmed);
    setIsEditingName(false);

    if (signalingRef.current) {
      signalingRef.current.renameDevice(trimmed);
    }
    setNotice({ text: `Device renamed to "${trimmed}"`, type: "success" });
  };

  // Join Specific Channel Handler
  const handleJoinChannel = (targetCode?: string) => {
    const raw = targetCode || channelInput;
    const code = raw.trim().toUpperCase();
    if (!code || code.length < 3) {
      setNotice({ text: "Please enter a valid channel code (3-12 characters).", type: "warning" });
      return;
    }

    if (code === channelCode) {
      setNotice({ text: `Already in channel ${code}`, type: "info" });
      setChannelInput("");
      return;
    }

    // Close existing peers & switch
    webrtcRef.current?.closeAllPeers();
    setRemoteMembers(new Map());
    setPeerStates(new Map());
    setChannelCode(code);
    localStorage.setItem(STORAGE_CHANNEL_CODE, code);
    setChannelInput("");

    if (signalingRef.current) {
      signalingRef.current.switchChannel(code);
    }
    setNotice({ text: `Joined channel ${code}! Discovering devices...`, type: "success" });
  };

  // New Channel Handler (Generates fresh room code)
  const handleNewChannel = () => {
    const freshCode = generateRandomCode();
    webrtcRef.current?.closeAllPeers();
    setRemoteMembers(new Map());
    setPeerStates(new Map());
    setChannelCode(freshCode);
    localStorage.setItem(STORAGE_CHANNEL_CODE, freshCode);
    setChannelInput("");

    if (signalingRef.current) {
      signalingRef.current.switchChannel(freshCode);
    }
    setNotice({ text: `Created new channel: ${freshCode}`, type: "success" });
  };

  // Leave Channel Handler
  const handleLeaveChannel = () => {
    webrtcRef.current?.closeAllPeers();
    setRemoteMembers(new Map());
    setPeerStates(new Map());
    if (signalingRef.current) {
      signalingRef.current.leaveChannel();
    }
    setNotice({ text: "Left channel. Enter or create a new channel code to connect.", type: "info" });
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

  // Prevent SSR Hydration mismatch: return clean skeleton if not mounted yet
  if (!isMounted) {
    return (
      <main className={styles.container}>
        <div className={styles.shell}>
          <header className={styles.header}>
            <div className={styles.brand}>
              <div className={styles.logoIcon}>⚡</div>
              <div>
                <h1 className={styles.brandTitle}>SlideDrop</h1>
                <p className={styles.brandSubtitle}>Direct P2P & Cloud Cross-Device Transfer</p>
              </div>
            </div>
            <div className={styles.headerActions}>
              <div className={`${styles.statusBadge} ${styles.statusConnecting}`}>
                <span className={styles.statusDot} />
                Connecting...
              </div>
            </div>
          </header>
        </div>
      </main>
    );
  }

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
                currentStatus === "P2P_CONNECTED"
                  ? styles.statusP2P
                  : currentStatus === "TRANSFERRING"
                  ? styles.statusConnecting
                  : currentStatus === "DEVICE_DISCOVERED" || currentStatus === "CONNECTING_PEER"
                  ? styles.statusConnecting
                  : currentStatus === "CHANNEL_JOINED"
                  ? styles.statusWaiting
                  : styles.statusDisconnected
              }`}
              onClick={() => setShowDiagnostics(true)}
              style={{ cursor: "pointer" }}
              title="Click to view connection diagnostics"
            >
              <span className={styles.statusDot} />
              {currentStatus === "P2P_CONNECTED"
                ? `🟢 P2P Connected (${connectedPeerIds.length} peer${connectedPeerIds.length > 1 ? "s" : ""})`
                : currentStatus === "TRANSFERRING"
                ? `⚡ Transferring (${transferProgress || 0}%)`
                : currentStatus === "CONNECTING_PEER"
                ? "Connecting P2P…"
                : currentStatus === "DEVICE_DISCOVERED"
                ? `🟢 Device Found (${otherDevices.length})`
                : currentStatus === "CHANNEL_JOINED"
                ? `Waiting for device (${channelCode})`
                : currentStatus === "CONNECTING_TO_SERVER"
                ? "Connecting Server…"
                : "Disconnected"}
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

        {/* Localhost Warning — Critical for cross-device debugging */}
        {typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && (
          <div className={styles.localhostWarning}>
            <strong>⚠️ Cross-device discovery will NOT work via localhost</strong>
            <span>
              You are accessing this app via <code>{window.location.hostname}:{window.location.port}</code>.
              Each physical device&apos;s <code>localhost</code> refers to itself.
              Both devices must connect to the <strong>same signaling server</strong>.
            </span>
            <span>
              <strong>To fix:</strong> Access this app via your LAN IP on <strong>all devices</strong>.
              Run <code>ifconfig</code> (macOS) or <code>ipconfig</code> (Windows) to find your host machine&apos;s LAN IP.
            </span>
            <div className={styles.localhostWarningCode}>
              Example: http://192.168.x.x:3000 (instead of localhost:3000)
            </div>
            <span style={{ fontSize: "12px", color: "#92400e" }}>
              Signaling URL being used: <code>{signalingUrl || getDefaultSignalingUrl()}</code>
            </span>
          </div>
        )}

        {/* Connection Info Bar — Always visible */}
        <div className={styles.connectionInfoBar}>
          <div className={styles.connectionInfoItem}>
            <span className={styles.connectionInfoLabel}>Signaling:</span>
            <span className={`${styles.connectionInfoDot} ${isWsConnected ? styles.connectionInfoDotOk : styles.connectionInfoDotFail}`} />
            <span className={styles.connectionInfoValue}>
              {signalingUrl || getDefaultSignalingUrl()}
            </span>
          </div>
          <div className={styles.connectionInfoItem}>
            <span className={styles.connectionInfoLabel}>WS:</span>
            <span className={styles.connectionInfoValue}>
              {isWsConnected ? "Connected" : "Disconnected"}
            </span>
          </div>
          <div className={styles.connectionInfoItem}>
            <span className={styles.connectionInfoLabel}>Channel:</span>
            <span className={styles.connectionInfoValue}>{channelCode}</span>
          </div>
          <div className={styles.connectionInfoItem}>
            <span className={styles.connectionInfoLabel}>Peers:</span>
            <span className={styles.connectionInfoValue}>{otherDevices.length} discovered, {connectedPeerIds.length} P2P</span>
          </div>
          <div className={styles.connectionInfoItem}>
            <span className={styles.connectionInfoLabel}>ID:</span>
            <span className={styles.connectionInfoValue}>{deviceId.slice(0, 12)}</span>
          </div>
        </div>

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
                  title="Copy Channel Code"
                >
                  Copy
                </button>
              </div>

              <input
                className={styles.inlineInput}
                style={{ width: "120px", minWidth: "100px", textTransform: "uppercase" }}
                placeholder="JOIN CODE"
                maxLength={10}
                value={channelInput}
                onChange={(e) => setChannelInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleJoinChannel()}
              />
              <button className={styles.secondaryBtn} onClick={() => handleJoinChannel()}>
                Join
              </button>

              <button
                className={styles.secondaryBtn}
                style={{ background: "#f1f5f9", borderColor: "#cbd5e1" }}
                onClick={handleNewChannel}
                title="Create a fresh new channel code"
              >
                🔄 New
              </button>

              <button
                className={styles.secondaryBtn}
                style={{ background: "#fef2f2", color: "#b91c1c", borderColor: "#fecaca" }}
                onClick={handleLeaveChannel}
                title="Leave the current channel"
              >
                🚪 Leave
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

            {/* Recipient Selector (Authoritative) */}
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
            <div className={styles.modalCard} onClick={(e) => e.stopPropagation()} style={{ width: "min(600px, 95vw)" }}>
              <div className={styles.modalHeader}>
                <h3 className={styles.modalTitle}>⚡ SlideDrop Diagnostics</h3>
                <button className={styles.modalCloseBtn} onClick={() => setShowDiagnostics(false)}>
                  ✕
                </button>
              </div>

              <div className={styles.diagnosticsContent}>
                <p className={styles.diagSectionTitle}>Connection</p>
                <div className={styles.diagRow}>
                  <span>Signaling URL:</span>
                  <strong>{signalingUrl || getDefaultSignalingUrl()}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>WebSocket Status:</span>
                  <strong>{isWsConnected ? "🟢 Connected" : "🔴 Disconnected"}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Active Channel:</span>
                  <strong>{channelCode}</strong>
                </div>

                <p className={styles.diagSectionTitle}>Identity</p>
                <div className={styles.diagRow}>
                  <span>Device ID:</span>
                  <strong><code>{deviceId}</code></strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Device Name:</span>
                  <strong>{deviceName}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Platform:</span>
                  <strong>{platformInfo.type}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Firebase Auth:</span>
                  <strong>{currentUser ? `Authenticated (${currentUser.uid.slice(0, 8)})` : "Anonymous"}</strong>
                </div>

                <p className={styles.diagSectionTitle}>Discovery</p>
                <div className={styles.diagRow}>
                  <span>Channel Members (total):</span>
                  <strong>{allDevices.length}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Remote Devices:</span>
                  <strong>{otherDevices.length} ({otherDevices.map(d => d.name).join(", ") || "none"})</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>WebRTC P2P Peers:</span>
                  <strong>{connectedPeerIds.length} connected</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Active Architecture:</span>
                  <strong>{connectedPeerIds.length > 0 ? "⚡ A (Direct WebRTC P2P)" : "☁️ B (Cloud Relay)"}</strong>
                </div>

                <p className={styles.diagSectionTitle}>Event Log ({signalingEvents.length})</p>
                <div className={styles.eventLog}>
                  {signalingEvents.length === 0 ? (
                    <span style={{ color: "#64748b" }}>No events yet...</span>
                  ) : (
                    signalingEvents.map((evt, i) => {
                      const time = new Date(evt.timestamp);
                      const ts = `${time.getHours().toString().padStart(2, "0")}:${time.getMinutes().toString().padStart(2, "0")}:${time.getSeconds().toString().padStart(2, "0")}`;
                      return (
                        <div key={`evt-${i}`} className={styles.eventLogEntry}>
                          <span className={styles.eventLogTime}>{ts}</span>
                          <span className={styles.eventLogName}>{evt.event}</span>
                          <span className={styles.eventLogDetail}>{evt.detail || ""}</span>
                        </div>
                      );
                    })
                  )}
                </div>

                {typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && (
                  <div className={styles.localhostWarning} style={{ marginTop: "8px" }}>
                    <strong>⚠️ Hostname is &quot;{window.location.hostname}&quot;</strong>
                    <span>Cross-device discovery requires all devices to use the same LAN IP, not localhost.</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
