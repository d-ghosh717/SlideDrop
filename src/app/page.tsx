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
import {
  Laptop,
  Monitor,
  Smartphone,
  Tablet,
  Globe,
  FileText,
  Image as ImageIcon,
  Film,
  FileArchive,
  FileCode,
  File as FileIcon,
  Copy,
  Check,
  Share2,
  Send,
  Plus,
  LogOut,
  Trash2,
  Download,
  AlertCircle,
  CheckCircle2,
  Info,
  X,
  Edit3,
  SlidersHorizontal,
  ArrowRight,
  Upload,
  MessageSquare,
  Zap,
  Cloud,
  Play,
  FileQuestion,
} from "lucide-react";
import { auth, db, storage } from "@/lib/firebase";
import { SignalingClient, getDefaultSignalingUrl } from "@/lib/signaling-client";
import type { SignalingEvent, SignalingState } from "@/lib/signaling-client";
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
  | "RECONNECTING"
  | "CHANNEL_JOINED"
  | "DEVICE_DISCOVERED"
  | "CONNECTING_PEER"
  | "P2P_CONNECTED"
  | "TRANSFERRING"
  | "OFFLINE"
  | "ERROR";

// ==================================================
// CUSTOM SLIDEDROP VECTOR LOGO MARK
// Vibrant sliding transfer planes forming a sleek "S"
// ==================================================
function SlideDropLogo({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="SlideDrop Logo"
    >
      <rect width="36" height="36" rx="10" fill="#0D1117" stroke="rgba(255,159,28,0.3)" strokeWidth="1" />
      {/* Top Sliding Plane (Rightward) */}
      <path
        d="M9 13.5C9 11.567 10.567 10 12.5 10H23C24.3807 10 25.5 11.1193 25.5 12.5C25.5 13.8807 24.3807 15 23 15H10.5C9.67157 15 9 14.3284 9 13.5Z"
        fill="#FF9F1C"
      />
      <circle cx="27" cy="12.5" r="2.2" fill="#FFC857" />

      {/* Bottom Sliding Plane (Leftward) */}
      <path
        d="M27 22.5C27 24.433 25.433 26 23.5 26H13C11.6193 26 10.5 24.8807 10.5 23.5C10.5 22.1193 11.6193 21 13 21H25.5C26.3284 21 27 21.6716 27 22.5Z"
        fill="#FF6B35"
      />
      <circle cx="9" cy="23.5" r="2.2" fill="#FF9F1C" />
    </svg>
  );
}

function getDevicePlatform(): { type: "desktop" | "mobile" | "tablet" | "browser"; defaultName: string } {
  if (typeof navigator === "undefined") {
    return { type: "desktop", defaultName: "Desktop" };
  }
  const ua = navigator.userAgent;
  const isMobile = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isTablet = /iPad|Tablet/i.test(ua);
  const isMac = /Macintosh|Mac OS X/i.test(ua);
  const isWindows = /Windows NT/i.test(ua);
  const isLinux = /Linux/i.test(ua) && !isMobile;

  if (isTablet) return { type: "tablet", defaultName: "iPad" };
  if (/iPhone/i.test(ua)) return { type: "mobile", defaultName: "iPhone" };
  if (/Android/i.test(ua)) return { type: "mobile", defaultName: "Android Phone" };
  if (isMac) return { type: "desktop", defaultName: "MacBook" };
  if (isWindows) return { type: "desktop", defaultName: "Windows PC" };
  if (isLinux) return { type: "desktop", defaultName: "Linux Desktop" };
  if (isMobile) return { type: "mobile", defaultName: "Mobile Device" };
  return { type: "desktop", defaultName: "Browser" };
}

function getDeviceIcon(type: string, name = "") {
  const lowerName = name.toLowerCase();
  if (type === "mobile" || lowerName.includes("iphone") || lowerName.includes("phone") || lowerName.includes("android")) {
    return <Smartphone size={24} strokeWidth={2} />;
  }
  if (type === "tablet" || lowerName.includes("ipad") || lowerName.includes("tablet")) {
    return <Tablet size={24} strokeWidth={2} />;
  }
  if (lowerName.includes("macbook") || lowerName.includes("laptop")) {
    return <Laptop size={24} strokeWidth={2} />;
  }
  if (type === "desktop" || lowerName.includes("pc") || lowerName.includes("desktop") || lowerName.includes("windows")) {
    return <Monitor size={24} strokeWidth={2} />;
  }
  return <Globe size={24} strokeWidth={2} />;
}

function renderFileThumbnail(mimeType = "", filename = "", downloadUrl = "") {
  const lower = filename.toLowerCase();
  const isImage = mimeType.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(lower);
  const isVideo = mimeType.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(lower);
  const isPdf = mimeType.includes("pdf") || lower.endsWith(".pdf");
  const isArchive = mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("compressed") || /\.(zip|tar|gz|rar|7z)$/i.test(lower);
  const isCode = mimeType.includes("json") || mimeType.includes("javascript") || mimeType.includes("typescript") || /\.(ts|js|jsx|tsx|html|css|py|json|md)$/i.test(lower);

  if (isImage && downloadUrl) {
    return <img src={downloadUrl} alt={filename} className={styles.transferThumbImg} />;
  }
  if (isImage) {
    return <ImageIcon size={28} strokeWidth={2} />;
  }
  if (isVideo) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, color: "#FF9F1C" }}>
        <Film size={26} strokeWidth={2} />
      </div>
    );
  }
  if (isPdf) {
    return (
      <div className={styles.pdfBadgeBox}>
        <FileText size={24} strokeWidth={2} />
        <span className={styles.pdfLabelPill}>PDF</span>
      </div>
    );
  }
  if (isArchive) {
    return <FileArchive size={26} strokeWidth={2} style={{ color: "#FBBF24" }} />;
  }
  if (isCode) {
    return <FileCode size={26} strokeWidth={2} style={{ color: "#38BDF8" }} />;
  }
  return <FileIcon size={26} strokeWidth={2} style={{ color: "#9AA4B2" }} />;
}

function generateRandomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
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
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `dev_${hex}`;
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
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
    const norm = fromUrl.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (norm.length >= 3) {
      localStorage.setItem(STORAGE_CHANNEL_CODE, norm);
      return norm;
    }
  }
  let stored = localStorage.getItem(STORAGE_CHANNEL_CODE);
  if (stored) {
    const norm = stored.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (norm.length >= 3) {
      return norm;
    }
  }
  const fresh = generateRandomCode();
  localStorage.setItem(STORAGE_CHANNEL_CODE, fresh);
  return fresh;
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
  // 1. Hydration Mount Guard
  const isMounted = useIsMounted();

  // 2. Client Identity & Channel State
  const [deviceId] = useState<string>(getInitialDeviceId);
  const [deviceName, setDeviceName] = useState<string>(getInitialDeviceName);
  const [channelCode, setChannelCode] = useState<string>(getInitialChannelCode);
  const [channelInput, setChannelInput] = useState("");
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(() => getInitialDeviceName());

  // 3. WebSocket Signaling & Peer Presence States
  const [isWsConnected, setIsWsConnected] = useState(false);
  const [signalingState, setSignalingState] = useState<SignalingState>("idle");
  const [remoteMembers, setRemoteMembers] = useState<Map<string, Device>>(new Map());
  const [peerStates, setPeerStates] = useState<Map<string, "connecting" | "connected" | "disconnected">>(new Map());

  // 4. Firebase Auth State (Cloud fallback)
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // 5. Transfer History, Multi-File Selection & Composer States
  const [transfers, setTransfers] = useState<Transfer[]>(getInitialTransfers);
  const [recipient, setRecipient] = useState<string>("all");
  const [composerMode, setComposerMode] = useState<"file" | "note">("file");
  const [textMessage, setTextMessage] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [filePreviews, setFilePreviews] = useState<Map<string, string>>(new Map());
  const [isDragging, setIsDragging] = useState(false);
  const [transferProgress, setTransferProgress] = useState<number | null>(null);
  const [transferStatusText, setTransferStatusText] = useState<string>("");
  const [multiRecipientProgress, setMultiRecipientProgress] = useState<Map<string, { percent: number; status: string; method: string }>>(new Map());
  const [recentReceived, setRecentReceived] = useState<Transfer | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [hasCopiedCode, setHasCopiedCode] = useState(false);
  const [hasCopiedLink, setHasCopiedLink] = useState(false);
  const [notice, setNotice] = useState<{ text: string; type: "success" | "warning" | "info" } | null>(null);
  const [signalingEvents, setSignalingEvents] = useState<SignalingEvent[]>([]);
  const [signalingUrl, setSignalingUrl] = useState<string>(() => (typeof window !== "undefined" ? getDefaultSignalingUrl() : ""));

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const transferManagerRef = useRef<TransferManager | null>(null);

  // Generate and manage local object URLs for multi-file previews
  useEffect(() => {
    const urls = new Map<string, string>();
    selectedFiles.forEach((file) => {
      if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
        const url = URL.createObjectURL(file);
        urls.set(`${file.name}-${file.size}`, url);
      }
    });
    setFilePreviews(urls);

    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [selectedFiles]);

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

  // Firebase Anonymous Auth (Architecture B fallback)
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
    let webrtc: WebRTCManager | null = null;

    const webrtcCallbacks = {
      onPeerConnected: (peerId: string) => {
        setPeerStates((prev) => new Map(prev).set(peerId, "connected"));
        setNotice({ text: "Direct WebRTC P2P connection established.", type: "success" });
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
          filename: msg.text.length > 40 ? msg.text.slice(0, 40) + "…" : "Text note",
          mimeType: "text/plain",
          size: msg.text.length,
          textContent: msg.text,
          status: "completed",
          method: "p2p",
          createdAt: new Date(msg.timestamp).toISOString(),
          expiresAt: new Date(msg.timestamp + 86400000).toISOString(),
        };
        appendTransfer(transfer);
        setRecentReceived(transfer);
        setNotice({ text: `Received note from ${msg.senderName}`, type: "success" });
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
        setRecentReceived(transfer);
        setNotice({ text: `Received "${fileTransfer.filename}" from ${fileTransfer.senderName}`, type: "success" });
      },
      onTransferAcknowledged: (transferId: string) => {
        console.log(`[WebRTC] Transfer ${transferId} acknowledged by recipient.`);
      },
    };

    const signaling = new SignalingClient({
      onStateChange: (state) => {
        setSignalingState(state);
        setIsWsConnected(state === "connected");
        if (state === "connected") {
          setErrorMessage(null);
        }
      },
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
      onMembersUpdated: (data) => {
        const map = new Map<string, Device>();
        for (const dev of data.devices) {
          map.set(dev.id, dev);
        }
        setRemoteMembers(map);
      },
      onDeviceUpdated: (device) => {
        setRemoteMembers((prev) => {
          const next = new Map(prev);
          next.set(device.id, device);
          return next;
        });
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

    signaling.connect(channelCode, deviceId, deviceName, platform.type);

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

  // Synchronize WebRTC Peer connections
  useEffect(() => {
    if (!webrtcRef.current) return;
    const remoteIds = Array.from(remoteMembers.keys()).filter((id) => id !== deviceId);
    webrtcRef.current.syncPeers(remoteIds);
  }, [remoteMembers, deviceId]);

  // Firestore Fallback Transfers Listener (Architecture B)
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
              setRecentReceived(transfer);
              setNotice({
                text: `Received ${data.textContent ? "note" : `"${data.filename}"`} from ${data.senderName} via Secure Relay`,
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

  const currentStatus: AppConnectionStatus = useMemo(() => {
    if (signalingState === "reconnecting") return "RECONNECTING";
    if (signalingState === "offline") return "OFFLINE";
    if (signalingState === "connecting" || !isWsConnected) return "CONNECTING_TO_SERVER";
    if (transferProgress !== null && transferProgress > 0 && transferProgress < 100) return "TRANSFERRING";
    if (connectedPeerIds.length > 0) return "P2P_CONNECTED";
    if (otherDevices.length > 0) {
      const isAnyConnecting = Array.from(peerStates.values()).some((s) => s === "connecting");
      return isAnyConnecting ? "CONNECTING_PEER" : "DEVICE_DISCOVERED";
    }
    return "CHANNEL_JOINED";
  }, [signalingState, isWsConnected, transferProgress, connectedPeerIds, otherDevices, peerStates]);

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
    const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code || code.length < 3 || code.length > 12) {
      setNotice({ text: "Please enter a valid channel code (3-12 alphanumeric characters).", type: "warning" });
      return;
    }

    if (code === channelCode) {
      setNotice({ text: `Already in channel ${code}`, type: "info" });
      setChannelInput("");
      return;
    }

    webrtcRef.current?.closeAllPeers();
    setRemoteMembers(new Map());
    setPeerStates(new Map());
    setChannelCode(code);
    localStorage.setItem(STORAGE_CHANNEL_CODE, code);
    setChannelInput("");

    if (signalingRef.current) {
      signalingRef.current.switchChannel(code);
    }
    setNotice({ text: `Joined channel ${code}. Discovering devices...`, type: "success" });
  };

  // New Channel Handler
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
    setChannelCode("");
    localStorage.removeItem(STORAGE_CHANNEL_CODE);
    if (signalingRef.current) {
      signalingRef.current.leaveChannel();
    }
    setNotice({ text: "Left channel. Enter or create a channel code to connect.", type: "info" });
  };

  // Send Text Note
  const handleSendText = async () => {
    const text = textMessage.trim();
    if (!text) {
      setNotice({ text: "Please enter a message or note to send.", type: "warning" });
      return;
    }

    const recipientDevice = otherDevices.find((d) => d.id === recipient);
    const targetRecipientName = recipient === "all" ? "All Devices" : recipientDevice?.name || "Peer";

    if (!transferManagerRef.current) return;

    setTransferStatusText("Sending note...");
    if (recipient === "all") {
      const promises = otherDevices.map((d) =>
        transferManagerRef.current!.sendText(d.id, d.name, text)
      );
      const results = await Promise.all(promises);
      let successCount = 0;
      results.forEach((r) => {
        if (r.success) {
          appendTransfer(r.transfer);
          successCount++;
        }
      });
      if (successCount > 0) {
        setTextMessage("");
        setTransferStatusText("");
        setNotice({ text: `Note delivered to ${successCount} device${successCount > 1 ? "s" : ""}.`, type: "success" });
      }
      return;
    }

    const result = await transferManagerRef.current.sendText(
      recipient,
      targetRecipientName,
      text
    );

    if (result.success) {
      appendTransfer(result.transfer);
      setTextMessage("");
      setTransferStatusText("");
      setNotice({
        text: result.method === "p2p" ? "Note delivered via P2P Direct." : "Note delivered via Secure Relay.",
        type: "success",
      });
    }
  };

  // Send Selected Files
  const handleSendFiles = async () => {
    if (selectedFiles.length === 0) {
      setNotice({ text: "Please select or drop files to send.", type: "warning" });
      return;
    }

    if (!transferManagerRef.current) return;

    const recipientDevice = otherDevices.find((d) => d.id === recipient);
    const targetRecipientName = recipient === "all" ? "All Devices" : recipientDevice?.name || "Peer";

    setTransferStatusText("Preparing files for transfer...");
    setTransferProgress(0);

    const filesToSend = [...selectedFiles];
    let totalSuccess = 0;

    if (recipient === "all") {
      for (let i = 0; i < filesToSend.length; i++) {
        const file = filesToSend[i];
        setTransferStatusText(`Sending ${file.name} (${i + 1}/${filesToSend.length})...`);

        const promises = otherDevices.map((d) => {
          const isP2P = peerStates.get(d.id) === "connected";
          return transferManagerRef.current!.sendFile(d.id, d.name, file, (percent) => {
            setMultiRecipientProgress((prev) => {
              const next = new Map(prev);
              next.set(d.id, { percent, status: `${percent}%`, method: isP2P ? "P2P Direct" : "Secure Relay" });
              return next;
            });
            setTransferProgress(percent);
          });
        });

        const results = await Promise.all(promises);
        results.forEach((r) => {
          if (r.success) {
            appendTransfer(r.transfer);
            totalSuccess++;
          }
        });
      }
    } else {
      for (let i = 0; i < filesToSend.length; i++) {
        const file = filesToSend[i];
        const result = await transferManagerRef.current.sendFile(
          recipient,
          targetRecipientName,
          file,
          (percent) => {
            setTransferProgress(percent);
            setTransferStatusText(`Transferring "${file.name}" (${percent}%)...`);
          }
        );
        if (result.success) {
          appendTransfer(result.transfer);
          totalSuccess++;
        }
      }
    }

    setSelectedFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setTransferProgress(null);
    setTransferStatusText("");
    setMultiRecipientProgress(new Map());

    if (totalSuccess > 0) {
      setNotice({
        text: `Successfully transferred ${filesToSend.length} file${filesToSend.length > 1 ? "s" : ""}!`,
        type: "success",
      });
    }
  };

  const handleTransferAction = async (transfer: Transfer) => {
    if (transfer.textContent) {
      try {
        await navigator.clipboard.writeText(transfer.textContent);
        setCopiedId(transfer.id);
        setNotice({ text: "Text copied to clipboard.", type: "success" });
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
    setHasCopiedLink(true);
    setNotice({ text: "Invite link copied to clipboard.", type: "success" });
    setTimeout(() => setHasCopiedLink(false), 2000);
  };

  const copyChannelCode = () => {
    navigator.clipboard.writeText(channelCode);
    setHasCopiedCode(true);
    setNotice({ text: `Channel code ${channelCode} copied.`, type: "success" });
    setTimeout(() => setHasCopiedCode(false), 2000);
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

  const removeSelectedFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
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
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const newFiles = Array.from(e.dataTransfer.files);
      setSelectedFiles((prev) => [...prev, ...newFiles]);
    }
  };

  const totalSelectedSize = useMemo(() => {
    return selectedFiles.reduce((acc, f) => acc + f.size, 0);
  }, [selectedFiles]);

  if (!isMounted) {
    return (
      <div className={styles.pageContainer}>
        <div className={styles.shell}>
          <header className={styles.header}>
            <div className={styles.brand}>
              <SlideDropLogo size={36} />
              <div className={styles.brandText}>
                <span className={styles.brandTitle}>SlideDrop</span>
                <span className={styles.brandSubtitle}>Share Instantly. Anywhere.</span>
              </div>
            </div>
          </header>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pageContainer}>
      <div className={styles.shell}>
        {/* ==================================================
            1. TOP FLOATING HEADER
            ================================================== */}
        <header className={styles.header}>
          <div className={styles.brand}>
            <SlideDropLogo size={36} />
            <div className={styles.brandText}>
              <span className={styles.brandTitle}>SlideDrop</span>
              <span className={styles.brandSubtitle}>Share Instantly. Anywhere.</span>
            </div>
          </div>

          <div className={styles.headerActions}>
            <button
              className={styles.statusPill}
              onClick={() => setShowDiagnostics(true)}
              title="Connection status - click for settings & telemetry"
              aria-label="Connection diagnostics and settings"
            >
              <span
                className={`${styles.statusDot} ${
                  currentStatus === "P2P_CONNECTED" || currentStatus === "CHANNEL_JOINED" || currentStatus === "DEVICE_DISCOVERED"
                    ? styles.statusDotOnline
                    : currentStatus === "TRANSFERRING" || currentStatus === "CONNECTING_TO_SERVER" || currentStatus === "RECONNECTING" || currentStatus === "CONNECTING_PEER"
                    ? styles.statusDotConnecting
                    : styles.statusDotOffline
                }`}
              />
              <span>
                {currentStatus === "RECONNECTING"
                  ? "Reconnecting..."
                  : currentStatus === "P2P_CONNECTED"
                  ? `P2P Direct (${connectedPeerIds.length})`
                  : currentStatus === "TRANSFERRING"
                  ? `Transferring (${transferProgress || 0}%)`
                  : currentStatus === "DEVICE_DISCOVERED"
                  ? `${otherDevices.length} online`
                  : currentStatus === "CHANNEL_JOINED"
                  ? `Connected`
                  : currentStatus === "CONNECTING_TO_SERVER"
                  ? "Connecting..."
                  : "Offline"}
              </span>
            </button>

            <button
              className={styles.iconBtn}
              onClick={() => setShowDiagnostics(true)}
              title="Settings & Telemetry"
              aria-label="Settings and diagnostics"
            >
              <SlidersHorizontal size={18} />
            </button>
          </div>
        </header>

        {/* Reconnecting Alert */}
        {currentStatus === "RECONNECTING" && (
          <div className={`${styles.noticeBanner} ${styles.noticeInfo}`} role="status">
            <div className={styles.noticeContent}>
              <Info size={18} />
              <span>Reconnecting to SlideDrop signaling...</span>
            </div>
          </div>
        )}

        {/* Notifications & System Alerts */}
        {errorMessage && (
          <div className={`${styles.noticeBanner} ${styles.noticeWarning}`} role="alert">
            <div className={styles.noticeContent}>
              <AlertCircle size={18} />
              <span>{errorMessage}</span>
            </div>
            <button className={styles.noticeClose} onClick={() => setErrorMessage(null)}>
              <X size={16} />
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
                : styles.noticeSuccess
            }`}
            role="status"
          >
            <div className={styles.noticeContent}>
              {notice.type === "warning" ? (
                <AlertCircle size={18} />
              ) : notice.type === "info" ? (
                <Info size={18} />
              ) : (
                <CheckCircle2 size={18} />
              )}
              <span>{notice.text}</span>
            </div>
            <button className={styles.noticeClose} onClick={() => setNotice(null)}>
              <X size={16} />
            </button>
          </div>
        )}

        {/* Prominent Received File Notification Card */}
        {recentReceived && (
          <div className={styles.receivedFileCard}>
            <div className={styles.receivedFileLeft}>
              <div className={styles.receivedThumbnailBox}>
                {renderFileThumbnail(recentReceived.mimeType, recentReceived.filename, recentReceived.downloadUrl || recentReceived.fileData)}
              </div>
              <div className={styles.receivedDetails}>
                <div className={styles.receivedBadgeRow}>
                  <CheckCircle2 size={13} />
                  <span>File Received</span>
                  <span style={{ opacity: 0.7, textTransform: "none", fontWeight: 500 }}>
                    • {recentReceived.method === "p2p" ? "P2P Direct" : "Secure Relay"}
                  </span>
                </div>
                <span className={styles.receivedFileName}>{recentReceived.filename}</span>
                <span className={styles.receivedFileMeta}>
                  {formatBytes(recentReceived.size)} • From <strong>{recentReceived.senderName}</strong>
                </span>
              </div>
            </div>
            <div className={styles.receivedActions}>
              <button
                className={styles.primaryBtn}
                onClick={() => handleTransferAction(recentReceived)}
              >
                <Download size={15} />
                <span>Download</span>
              </button>
              <button
                className={styles.iconBtn}
                onClick={() => setRecentReceived(null)}
                title="Dismiss"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ==================================================
            2. CHANNEL HERO (Warm Atmospheric Lighting)
            ================================================== */}
        <section className={styles.channelHero} aria-label="Current Channel Info">
          <div className={styles.channelMainRow}>
            <div className={styles.channelInfoBlock}>
              <span className={styles.channelTag}>Current Channel</span>
              <span className={styles.channelCodeDisplay}>{channelCode}</span>
              <p className={styles.channelHint}>
                Share this channel code or link with another device to connect instantly.
              </p>
            </div>

            <div className={styles.channelPrimaryActions}>
              <button className={styles.primaryBtn} onClick={copyChannelCode}>
                {hasCopiedCode ? <Check size={16} /> : <Copy size={16} />}
                <span>{hasCopiedCode ? "Copied Code" : "Copy Code"}</span>
              </button>
              <button className={styles.secondaryBtn} onClick={copyShareLink}>
                {hasCopiedLink ? <Check size={16} /> : <Share2 size={16} />}
                <span>{hasCopiedLink ? "Copied Link" : "Share Link"}</span>
              </button>
            </div>
          </div>

          <div className={styles.channelSecondaryRow}>
            <div className={styles.joinForm}>
              <input
                className={styles.channelInput}
                placeholder="JOIN CODE"
                maxLength={12}
                value={channelInput}
                onChange={(e) => setChannelInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleJoinChannel()}
                aria-label="Join Channel Code Input"
              />
              <button
                className={styles.secondaryBtn}
                onClick={() => handleJoinChannel()}
                disabled={!channelInput.trim()}
              >
                Join
              </button>
            </div>

            <div className={styles.channelTools}>
              <button className={styles.secondaryBtn} onClick={handleNewChannel} title="Create fresh new channel">
                <Plus size={15} />
                <span>New Channel</span>
              </button>
              <button className={styles.dangerBtn} onClick={handleLeaveChannel} title="Leave channel">
                <LogOut size={15} />
                <span>Leave</span>
              </button>
            </div>
          </div>
        </section>

        {/* ==================================================
            3. DEVICES IN CHANNEL
            ================================================== */}
        <section className={styles.deviceSection} aria-label="Devices in Channel">
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              <span>Devices in Channel</span>
              <span className={styles.countBadge}>{allDevices.length}</span>
            </div>

            <div className={styles.deviceSettingsToggle}>
              {isEditingName ? (
                <div className={styles.nameEditForm}>
                  <input
                    className={styles.nameInput}
                    placeholder="Device name"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveName()}
                    autoFocus
                  />
                  <button className={styles.primaryBtn} onClick={handleSaveName}>
                    Save
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
                </div>
              ) : (
                <button
                  className={styles.secondaryBtn}
                  onClick={() => {
                    setNameInput(deviceName);
                    setIsEditingName(true);
                  }}
                  title="Rename your device"
                >
                  <Edit3 size={14} />
                  <span>Rename ({deviceName})</span>
                </button>
              )}
            </div>
          </div>

          <div className={styles.deviceGrid}>
            {/* Local Device Card */}
            <div className={`${styles.deviceCardItem} ${styles.deviceCardSelected}`}>
              <div className={styles.deviceCardHeader}>
                <div className={styles.deviceIconBox}>
                  {getDeviceIcon(platformInfo.type, deviceName)}
                </div>
                <span className={styles.thisDeviceBadge}>This Device</span>
              </div>
              <div className={styles.deviceInfo}>
                <span className={styles.deviceName}>{deviceName}</span>
                <div className={styles.deviceMetaRow}>
                  <span className={styles.statusDotOnline} style={{ width: 7, height: 7, borderRadius: "50%" }} />
                  <span>Online</span>
                  <span>•</span>
                  <span>{platformInfo.type}</span>
                </div>
              </div>
            </div>

            {/* Remote Channel Members */}
            {otherDevices.map((remote) => {
              const peerState = peerStates.get(remote.id);
              const isP2P = peerState === "connected";
              const isConnecting = peerState === "connecting";
              const isSelected = recipient === remote.id;

              return (
                <div
                  key={remote.id}
                  className={`${styles.deviceCardItem} ${isSelected ? styles.deviceCardSelected : ""}`}
                  onClick={() => setRecipient(remote.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      setRecipient(remote.id);
                    }
                  }}
                  aria-label={`Select ${remote.name} as transfer recipient`}
                >
                  <div className={styles.deviceCardHeader}>
                    <div className={styles.deviceIconBox}>
                      {getDeviceIcon(remote.type, remote.name)}
                    </div>
                    <span
                      className={`${styles.transportBadge} ${
                        isP2P
                          ? styles.transportP2P
                          : isConnecting
                          ? styles.transportConnecting
                          : styles.transportCloud
                      }`}
                    >
                      {isP2P ? (
                        <>
                          <Zap size={11} /> P2P Ready
                        </>
                      ) : isConnecting ? (
                        <>
                          <ArrowRight size={11} /> Connecting...
                        </>
                      ) : (
                        <>
                          <Cloud size={11} /> Cloud Ready
                        </>
                      )}
                    </span>
                  </div>

                  <div className={styles.deviceInfo}>
                    <span className={styles.deviceName}>{remote.name}</span>
                    <div className={styles.deviceMetaRow}>
                      <span className={styles.statusDotOnline} style={{ width: 7, height: 7, borderRadius: "50%" }} />
                      <span>Online</span>
                      <span>•</span>
                      <span>{remote.type}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {otherDevices.length === 0 && (
            <div className={styles.emptyDevices}>
              <p className={styles.emptyDevicesTitle}>No other devices connected yet</p>
              <p className={styles.emptyDevicesSubtitle}>
                Open SlideDrop on another phone, computer, or tablet with channel <strong>{channelCode}</strong> to connect and send files.
              </p>
            </div>
          )}
        </section>

        {/* ==================================================
            4. MAIN 2-COLUMN WORKSPACE: SEND FILES & HISTORY
            ================================================== */}
        <div className={styles.mainGrid}>
          {/* Send Files Panel */}
          <section className={styles.panel} aria-label="Send files to devices">
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>
                <Upload size={20} />
                <span>Send Files</span>
              </h2>
            </div>

            {/* Recipient Selection */}
            <div className={styles.fieldGroup}>
              <div className={styles.fieldLabelRow}>
                <label htmlFor="recipient-select" className={styles.fieldLabel}>
                  Recipient
                </label>
                <span className={styles.fieldHint}>
                  {recipient === "all"
                    ? "Each device will use the fastest available connection."
                    : "Direct transfer to selected device."}
                </span>
              </div>
              <select
                id="recipient-select"
                className={styles.selectInput}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              >
                <option value="all">
                  All Devices in Channel ({otherDevices.length} available)
                </option>
                {otherDevices.map((d) => {
                  const isP2P = peerStates.get(d.id) === "connected";
                  return (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.type}) — {isP2P ? "P2P Direct" : "Secure Relay"}
                    </option>
                  );
                })}
              </select>
            </div>

            {/* Mode Segmented Controls */}
            <div className={styles.composerTabs}>
              <button
                className={`${styles.composerTab} ${composerMode === "file" ? styles.composerTabActive : ""}`}
                onClick={() => setComposerMode("file")}
                type="button"
              >
                <Upload size={15} />
                <span>File Transfer</span>
              </button>
              <button
                className={`${styles.composerTab} ${composerMode === "note" ? styles.composerTabActive : ""}`}
                onClick={() => setComposerMode("note")}
                type="button"
              >
                <MessageSquare size={15} />
                <span>Quick Note</span>
              </button>
            </div>

            {composerMode === "file" ? (
              <div className={styles.fieldGroup}>
                {/* Large Dropzone */}
                <div
                  className={`${styles.dropzone} ${isDragging ? styles.dropzoneActive : ""}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      fileInputRef.current?.click();
                    }
                  }}
                  aria-label="File upload dropzone"
                >
                  <div className={styles.dropzoneIconBox}>
                    <Upload size={28} />
                  </div>
                  <p className={styles.dropzoneTitle}>
                    {selectedFiles.length > 0 ? "Add more files or drop here" : "Drop files here or click to browse"}
                  </p>
                  <p className={styles.dropzoneSub}>
                    Supports images, videos, PDFs, archives, documents and more.
                  </p>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                  >
                    <Upload size={15} />
                    <span>Select Files</span>
                  </button>
                  <input
                    type="file"
                    multiple
                    ref={fileInputRef}
                    style={{ display: "none" }}
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        const files = Array.from(e.target.files);
                        setSelectedFiles((prev) => [...prev, ...files]);
                      }
                    }}
                  />
                </div>

                {/* Multi-File Preview Strip */}
                {selectedFiles.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <div className={styles.selectedFilesSummary}>
                      <span className={styles.selectedFilesCount}>
                        {selectedFiles.length} file{selectedFiles.length > 1 ? "s" : ""} selected • {formatBytes(totalSelectedSize)}
                      </span>
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        style={{ padding: "4px 10px", minHeight: "30px", fontSize: "12px" }}
                        onClick={() => {
                          setSelectedFiles([]);
                          if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                      >
                        Clear all
                      </button>
                    </div>

                    <div className={styles.filePreviewStrip}>
                      {selectedFiles.map((file, idx) => {
                        const previewKey = `${file.name}-${file.size}`;
                        const previewUrl = filePreviews.get(previewKey);
                        const isImage = file.type.startsWith("image/");
                        const isVideo = file.type.startsWith("video/");
                        const isPdf = file.type.includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
                        const isArchive = file.type.includes("zip") || file.type.includes("tar") || file.type.includes("compressed") || /\.(zip|tar|gz|rar|7z)$/i.test(file.name);
                        const isCode = file.type.includes("json") || file.type.includes("javascript") || file.type.includes("typescript") || /\.(ts|js|jsx|tsx|html|css|py|json|md)$/i.test(file.name);

                        return (
                          <div key={`${file.name}-${idx}`} className={styles.filePreviewCard}>
                            <button
                              className={styles.previewRemoveBtn}
                              onClick={() => removeSelectedFile(idx)}
                              title="Remove file"
                              aria-label={`Remove ${file.name}`}
                            >
                              <X size={14} />
                            </button>

                            <div className={styles.previewThumbnailWrapper}>
                              {isImage && previewUrl ? (
                                <img
                                  src={previewUrl}
                                  alt={file.name}
                                  className={styles.previewThumbnailImg}
                                />
                              ) : isVideo && previewUrl ? (
                                <>
                                  <video
                                    src={previewUrl}
                                    className={styles.previewThumbnailImg}
                                    muted
                                  />
                                  <div className={styles.previewPlayBadge}>
                                    <Play size={22} fill="#ffffff" />
                                  </div>
                                </>
                              ) : isPdf ? (
                                <div className={styles.pdfBadgeBox}>
                                  <FileText size={26} strokeWidth={2} />
                                  <span className={styles.pdfLabelPill}>PDF</span>
                                </div>
                              ) : isArchive ? (
                                <FileArchive size={28} strokeWidth={2} style={{ color: "#FBBF24" }} />
                              ) : isCode ? (
                                <FileCode size={28} strokeWidth={2} style={{ color: "#38BDF8" }} />
                              ) : (
                                <FileIcon size={28} strokeWidth={2} style={{ color: "#9AA4B2" }} />
                              )}
                            </div>

                            <div className={styles.previewMeta}>
                              <span className={styles.previewMetaName} title={file.name}>
                                {file.name}
                              </span>
                              <span className={styles.previewMetaSub}>
                                {formatBytes(file.size)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Transfer Progress Card */}
                {transferProgress !== null && (
                  <div className={styles.progressCard}>
                    <div className={styles.progressHeader}>
                      <span>{transferStatusText}</span>
                      <span>{transferProgress}%</span>
                    </div>
                    <div className={styles.progressBarBg}>
                      <div
                        className={styles.progressBarFill}
                        style={{ width: `${Math.max(4, transferProgress)}%` }}
                      />
                    </div>

                    {multiRecipientProgress.size > 0 && (
                      <div className={styles.multiRecipientList}>
                        {Array.from(multiRecipientProgress.entries()).map(([peerId, info]) => {
                          const dev = otherDevices.find((d) => d.id === peerId);
                          return (
                            <div key={peerId} className={styles.multiRecipientItem}>
                              <span>{dev?.name || "Peer"} ({info.method})</span>
                              <strong>{info.status}</strong>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                <button
                  className={`${styles.primaryBtn} ${styles.sendBtn}`}
                  disabled={
                    selectedFiles.length === 0 ||
                    (transferProgress !== null && transferProgress > 0 && transferProgress < 100)
                  }
                  onClick={handleSendFiles}
                >
                  <Send size={18} />
                  <span>
                    {selectedFiles.length > 0
                      ? `Send ${selectedFiles.length} File${selectedFiles.length > 1 ? "s" : ""}`
                      : "Send Files"}
                  </span>
                </button>
              </div>
            ) : (
              <div className={styles.fieldGroup}>
                <div className={styles.fieldLabelRow}>
                  <label htmlFor="text-note" className={styles.fieldLabel}>
                    Quick Note or Link
                  </label>
                  <span className={styles.fieldHint}>{textMessage.length} characters</span>
                </div>
                <textarea
                  id="text-note"
                  className={styles.textareaInput}
                  placeholder="Type a message, paste links, code snippets, or notes to send instantly..."
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
                  <Send size={18} />
                  <span>Send Note</span>
                </button>
              </div>
            )}
          </section>

          {/* Recent Transfers History Panel */}
          <section className={styles.panel} aria-label="Recent Transfers">
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>
                <Download size={20} />
                <span>Recent Transfers</span>
                {transfers.length > 0 && (
                  <span className={styles.countBadge}>{transfers.length}</span>
                )}
              </h2>
              {transfers.length > 0 && (
                <button className={styles.secondaryBtn} onClick={clearHistory}>
                  Clear
                </button>
              )}
            </div>

            {transfers.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIconBox}>
                  <Download size={24} />
                </div>
                <p className={styles.emptyTitle}>No transfers yet</p>
                <p className={styles.emptySubtitle}>
                  Files and text you send or receive will appear here in real-time.
                </p>
              </div>
            ) : (
              <div className={styles.transferList}>
                {transfers.map((item) => {
                  const isSentByMe = item.senderDeviceId === deviceId;
                  const isText = Boolean(item.textContent);
                  const isP2P = item.method === "p2p";

                  return (
                    <div
                      key={item.id}
                      className={styles.transferItem}
                      onClick={() => handleTransferAction(item)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          handleTransferAction(item);
                        }
                      }}
                      title={isText ? "Click to copy note" : "Click to download"}
                    >
                      <div className={styles.transferLeft}>
                        {/* LARGE PREVIEW THUMBNAIL (VISUAL ANCHOR) */}
                        <div className={styles.transferThumbBox}>
                          {isText ? (
                            <MessageSquare size={24} strokeWidth={2} />
                          ) : (
                            renderFileThumbnail(item.mimeType, item.filename, item.downloadUrl || item.fileData)
                          )}
                        </div>

                        <div className={styles.transferDetails}>
                          {/* 1. FILE/TEXT IS DOMINANT */}
                          {isText ? (
                            <p className={styles.transferTextQuote}>
                              &ldquo;{item.textContent}&rdquo;
                            </p>
                          ) : (
                            <span className={styles.transferName} title={item.filename}>
                              {item.filename}
                            </span>
                          )}

                          {/* 2. PERSON & SIZE IS SECOND */}
                          <div className={styles.transferMetaRow}>
                            <span>
                              {isSentByMe ? `To: ${item.recipientName}` : `From: ${item.senderName}`}
                            </span>
                            <span>•</span>
                            <span>{formatBytes(item.size)}</span>
                            <span>•</span>
                            <span>{formatTime(item.createdAt)}</span>
                            <span>•</span>
                            <span className={styles.transferStatusCompleted}>
                              <Check size={12} strokeWidth={3} /> Completed
                            </span>
                            <span>•</span>
                            <span className={styles.transferSubtleTransport}>
                              {isP2P ? <Zap size={11} /> : <Cloud size={11} />}
                              {isP2P ? "P2P Direct" : "Secure Relay"}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className={styles.transferActions}>
                        <button
                          className={styles.secondaryBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTransferAction(item);
                          }}
                          aria-label={isText ? "Copy note" : "Download file"}
                        >
                          {copiedId === item.id ? (
                            <>
                              <Check size={14} />
                              <span>Copied</span>
                            </>
                          ) : isText ? (
                            <>
                              <Copy size={14} />
                              <span>Copy</span>
                            </>
                          ) : (
                            <>
                              <Download size={14} />
                              <span>Download</span>
                            </>
                          )}
                        </button>
                        <button
                          className={styles.iconBtn}
                          onClick={(e) => deleteTransfer(item.id, e)}
                          title="Delete"
                          aria-label="Delete"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ==================================================
          SETTINGS & TELEMETRY MODAL
          ================================================== */}
      {showDiagnostics && (
        <div className={styles.modalOverlay} onClick={() => setShowDiagnostics(false)}>
          <div
            className={styles.modalCard}
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(580px, 95vw)" }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className={styles.modalHeader}>
              <h3 id="settings-title" className={styles.modalTitle}>
                <SlidersHorizontal size={20} />
                <span>Settings & Diagnostics</span>
              </h3>
              <button
                className={styles.iconBtn}
                onClick={() => setShowDiagnostics(false)}
                aria-label="Close settings"
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div>
                <p className={styles.diagSectionTitle}>Device Identity</p>
                <div className={styles.diagRow}>
                  <span>Device Name:</span>
                  <strong>{deviceName}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Device ID:</span>
                  <strong><code>{deviceId}</code></strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Platform:</span>
                  <strong>{platformInfo.type}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Firebase Auth:</span>
                  <strong>{currentUser ? `Authenticated (${currentUser.uid.slice(0, 8)})` : "Anonymous"}</strong>
                </div>
              </div>

              <div>
                <p className={styles.diagSectionTitle}>Connection Details</p>
                <div className={styles.diagRow}>
                  <span>Signaling Server:</span>
                  <strong>{signalingUrl || getDefaultSignalingUrl()}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>WebSocket Status:</span>
                  <strong>{isWsConnected ? "Connected" : "Disconnected"}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Current Channel:</span>
                  <strong>{channelCode}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>Channel Members:</span>
                  <strong>{allDevices.length}</strong>
                </div>
                <div className={styles.diagRow}>
                  <span>WebRTC DataChannels:</span>
                  <strong>{connectedPeerIds.length} connected</strong>
                </div>
              </div>

              <div>
                <p className={styles.diagSectionTitle}>About SlideDrop</p>
                <div className={styles.aboutBox}>
                  SlideDrop enables private, direct device-to-device file and text note transfer using WebRTC P2P DataChannels, with encrypted Firebase Storage relay fallback when peer connections are restricted by NATs/firewalls.
                </div>
              </div>

              <div>
                <p className={styles.diagSectionTitle}>Signaling Event Log ({signalingEvents.length})</p>
                <div className={styles.eventLog}>
                  {signalingEvents.length === 0 ? (
                    <span style={{ color: "var(--text-muted)" }}>No events recorded yet...</span>
                  ) : (
                    signalingEvents.map((evt, i) => {
                      const time = new Date(evt.timestamp);
                      const ts = `${time.getHours().toString().padStart(2, "0")}:${time.getMinutes().toString().padStart(2, "0")}:${time.getSeconds().toString().padStart(2, "0")}`;
                      return (
                        <div key={`evt-${i}`} className={styles.eventLogEntry}>
                          <span className={styles.eventLogTime}>{ts}</span>
                          <span className={styles.eventLogName}>{evt.event}</span>
                          <span style={{ color: "var(--text-secondary)" }}>{evt.detail || ""}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
