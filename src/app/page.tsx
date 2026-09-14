"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { WebRTCManager } from "@/lib/webrtc";
import type { Device, Transfer } from "@/lib/types";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const STORAGE_DEVICE_ID = "slidedrop-device-uuid";
const STORAGE_DEVICE_NAME = "slidedrop-device-name";
const STORAGE_CHANNEL_CODE = "slidedrop-channel-code";
const STORAGE_TRANSFERS = "slidedrop-transfers-history";

type ConnectionState = "INITIALIZING" | "CONNECTING" | "WAITING_FOR_DEVICE" | "PEER_CONNECTED" | "DISCONNECTED" | "ERROR";

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
  if (/Android/i.test(ua)) return { type: "mobile", defaultName: "Android", icon: "📱" };
  if (isMac) return { type: "desktop", defaultName: "MacBook", icon: "💻" };
  if (isWindows) return { type: "desktop", defaultName: "Windows PC", icon: "🖥️" };
  if (isLinux) return { type: "desktop", defaultName: "Linux Desktop", icon: "🖥️" };
  if (isMobile) return { type: "mobile", defaultName: "Mobile", icon: "📱" };
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
  // 1. Device identity
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

  // 2. Channel code state
  const [channelCode, setChannelCode] = useState<string>(() => {
    if (typeof window === "undefined") return "DEFAULT";
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

  // 3. Network & Connection states
  const [connectionState, setConnectionState] = useState<ConnectionState>("CONNECTING");
  const [connectedPeerIds, setConnectedPeerIds] = useState<string[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
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

  // 4. Composer & Progress states
  const [recipient, setRecipient] = useState<string>("all");
  const [textMessage, setTextMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [transferProgress, setTransferProgress] = useState<number | null>(null);
  const [transferStatusText, setTransferStatusText] = useState<string>("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; type: "success" | "warning" | "info" } | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const relayPollTimerRef = useRef<number | null>(null);

  // Save transfers to localStorage
  const appendTransfer = useCallback((transfer: Transfer) => {
    setTransfers((prev) => {
      if (prev.some((t) => t.id === transfer.id)) return prev;
      const next = [transfer, ...prev];
      localStorage.setItem(STORAGE_TRANSFERS, JSON.stringify(next));
      return next;
    });
  }, []);

  // Initialize WebRTC Manager & callbacks
  useEffect(() => {
    if (typeof window === "undefined") return;

    const callbacks = {
      onPeerConnected: (peerId: string) => {
        setConnectedPeerIds((prev) => {
          if (prev.includes(peerId)) return prev;
          return [...prev, peerId];
        });
        setNotice({ text: "Peer device connected directly via WebRTC!", type: "success" });
      },
      onPeerDisconnected: (peerId: string) => {
        setConnectedPeerIds((prev) => prev.filter((id) => id !== peerId));
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
        setNotice({ text: `Received text note from ${msg.senderName}`, type: "success" });
      },
      onFileProgress: (transferId: string, percent: number, direction: "send" | "receive") => {
        setTransferProgress(percent);
        setTransferStatusText(direction === "send" ? `Sending file (${percent}%)...` : `Receiving file (${percent}%)...`);
        if (percent >= 100) {
          setTimeout(() => {
            setTransferProgress(null);
            setTransferStatusText("");
          }, 1000);
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
        setNotice({ text: `Received "${fileTransfer.filename}" from ${fileTransfer.senderName}!`, type: "success" });
      },
    };

    const mgr = new WebRTCManager(deviceId, channelCode, callbacks);
    mgr.startSignaling();
    webrtcRef.current = mgr;

    return () => {
      mgr.stop();
      webrtcRef.current = null;
    };
  }, [deviceId, channelCode, deviceName, appendTransfer]);

  // Presence & Heartbeat Loop: posts to `/api/channel/[code]` every 4s
  const performHeartbeat = useCallback(async () => {
    try {
      const platform = getDevicePlatform();
      const res = await fetch(`/api/channel/${encodeURIComponent(channelCode)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          deviceName,
          platform: platform.type,
        }),
      });

      if (!res.ok) {
        setConnectionState("ERROR");
        return;
      }

      const data = await res.json();
      if (data.success && Array.isArray(data.devices)) {
        const rawList = data.devices as Array<{
          deviceId: string;
          deviceName: string;
          platform: string;
          online: boolean;
          lastSeen: number;
        }>;

        const mapped: Device[] = rawList.map((d) => ({
          id: d.deviceId,
          userId: d.deviceId,
          accountId: channelCode,
          name: d.deviceName,
          type: d.platform,
          pairingCode: channelCode,
          online: d.online,
          lastSeen: d.lastSeen,
          createdAt: d.lastSeen,
        }));

        setDevices(mapped);

        const remoteIds = rawList.map((d) => d.deviceId).filter((id) => id !== deviceId);

        // Sync peers with WebRTC Manager
        if (webrtcRef.current) {
          webrtcRef.current.syncPeers(remoteIds);
          const p2pCount = webrtcRef.current.getConnectedPeerCount();
          if (p2pCount > 0) {
            setConnectionState("PEER_CONNECTED");
          } else if (remoteIds.length > 0) {
            setConnectionState("CONNECTING");
          } else {
            setConnectionState("WAITING_FOR_DEVICE");
          }
        }
      }
    } catch {
      setConnectionState("DISCONNECTED");
    }
  }, [channelCode, deviceId, deviceName]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      performHeartbeat();
    }, 0);
    const interval = window.setInterval(() => {
      performHeartbeat();
    }, 4000);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [performHeartbeat]);

  // Relay transfers polling (fallback when peer DataChannel is not open)
  useEffect(() => {
    const pollRelays = async () => {
      try {
        const res = await fetch(`/api/transfer?channel=${encodeURIComponent(channelCode)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.success && Array.isArray(data.transfers)) {
          for (const item of data.transfers) {
            if (item.senderDeviceId !== deviceId) {
              const transfer: Transfer = {
                id: item.id,
                userId: item.senderDeviceId,
                accountId: channelCode,
                senderDeviceId: item.senderDeviceId,
                recipientDeviceId: item.recipientDeviceId,
                senderName: item.senderName,
                recipientName: item.recipientName,
                filename: item.filename,
                mimeType: item.mimeType,
                size: item.size,
                textContent: item.textContent,
                fileData: item.fileData,
                status: "completed",
                method: "broadcast",
                createdAt: new Date(item.timestamp).toISOString(),
                expiresAt: new Date(item.timestamp + 86400000).toISOString(),
              };
              appendTransfer(transfer);
            }
          }
        }
      } catch {
        // Retry next interval
      }
    };

    relayPollTimerRef.current = window.setInterval(pollRelays, 3000);
    return () => {
      if (relayPollTimerRef.current) clearInterval(relayPollTimerRef.current);
    };
  }, [channelCode, deviceId, appendTransfer]);

  // Rename Device
  const handleSaveName = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setNotice({ text: "Device name cannot be empty.", type: "warning" });
      return;
    }
    setDeviceName(trimmed);
    localStorage.setItem(STORAGE_DEVICE_NAME, trimmed);
    setIsEditingName(false);
    performHeartbeat();
    setNotice({ text: `Device renamed to "${trimmed}"`, type: "success" });
  };

  // Join Channel
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

    // Leave current channel
    fetch(`/api/channel/${encodeURIComponent(channelCode)}?deviceId=${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    }).catch(() => {});

    setChannelCode(code);
    localStorage.setItem(STORAGE_CHANNEL_CODE, code);
    setChannelInput("");
    setConnectedPeerIds([]);
    setConnectionState("CONNECTING");
    setNotice({ text: `Joined channel ${code}! Discovering devices...`, type: "success" });
  };

  // Send Text Note
  const handleSendText = async () => {
    const text = textMessage.trim();
    if (!text) {
      setNotice({ text: "Please enter a message to send.", type: "warning" });
      return;
    }

    const recipientDevice = devices.find((d) => d.id === recipient);
    const targetRecipientName = recipient === "all" ? "All Devices" : recipientDevice?.name || "Peer";

    let sentP2P = false;
    if (webrtcRef.current && webrtcRef.current.getConnectedPeerCount() > 0) {
      sentP2P = webrtcRef.current.sendText(text, deviceName, recipient === "all" ? undefined : recipient);
    }

    // Fallback to relay API if P2P not available
    if (!sentP2P) {
      try {
        await fetch("/api/transfer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            senderDeviceId: deviceId,
            recipientDeviceId: recipient,
            channelCode,
            senderName: deviceName,
            recipientName: targetRecipientName,
            filename: text.length > 30 ? text.slice(0, 30) + "…" : "Text note",
            mimeType: "text/plain",
            size: text.length,
            textContent: text,
          }),
        });
      } catch (err) {
        console.warn("Relay send text error", err);
      }
    }

    const localTransfer: Transfer = {
      id: "txt_" + Math.random().toString(36).substring(2, 10),
      userId: deviceId,
      accountId: channelCode,
      senderDeviceId: deviceId,
      recipientDeviceId: recipient,
      senderName: deviceName,
      recipientName: targetRecipientName,
      filename: text.length > 30 ? text.slice(0, 30) + "…" : "Text note",
      mimeType: "text/plain",
      size: text.length,
      textContent: text,
      status: "completed",
      method: sentP2P ? "p2p" : "broadcast",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };

    appendTransfer(localTransfer);
    setTextMessage("");
    setNotice({
      text: sentP2P ? "Text sent directly via WebRTC!" : "Text sent via Relay Sync!",
      type: "success",
    });
  };

  // Send File
  const handleSendFile = async () => {
    if (!selectedFile) {
      setNotice({ text: "Please select or drop a file to send.", type: "warning" });
      return;
    }

    const recipientDevice = devices.find((d) => d.id === recipient);
    const targetRecipientName = recipient === "all" ? "All Devices" : recipientDevice?.name || "Peer";

    setTransferStatusText("Preparing file for transfer...");
    setTransferProgress(0);

    let sentP2P = false;
    if (webrtcRef.current && webrtcRef.current.getConnectedPeerCount() > 0) {
      try {
        sentP2P = await webrtcRef.current.sendFile(
          selectedFile,
          deviceName,
          recipient === "all" ? undefined : recipient,
          (percent) => {
            setTransferProgress(percent);
            setTransferStatusText(`Sending "${selectedFile.name}" (${percent}%)...`);
          }
        );
      } catch (err) {
        console.warn("WebRTC send file error, falling back to relay", err);
      }
    }

    // Fallback to relay API
    if (!sentP2P) {
      setTransferStatusText("Sending via server relay...");
      try {
        const fileData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(selectedFile);
        });

        await fetch("/api/transfer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            senderDeviceId: deviceId,
            recipientDeviceId: recipient,
            channelCode,
            senderName: deviceName,
            recipientName: targetRecipientName,
            filename: selectedFile.name,
            mimeType: selectedFile.type || "application/octet-stream",
            size: selectedFile.size,
            fileData,
          }),
        });
      } catch (err) {
        console.error("Relay upload error", err);
      }
    }

    const localTransfer: Transfer = {
      id: "file_" + Math.random().toString(36).substring(2, 10),
      userId: deviceId,
      accountId: channelCode,
      senderDeviceId: deviceId,
      recipientDeviceId: recipient,
      senderName: deviceName,
      recipientName: targetRecipientName,
      filename: selectedFile.name,
      mimeType: selectedFile.type || "application/octet-stream",
      size: selectedFile.size,
      downloadUrl: URL.createObjectURL(selectedFile),
      status: "completed",
      method: sentP2P ? "p2p" : "broadcast",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };

    appendTransfer(localTransfer);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setTransferProgress(null);
    setTransferStatusText("");
    setNotice({
      text: sentP2P ? `"${selectedFile.name}" sent via WebRTC P2P!` : `"${selectedFile.name}" sent via Relay!`,
      type: "success",
    });
  };

  // Download / Copy actions
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
    setNotice({ text: "Channel invite link copied! Open on another device to connect.", type: "success" });
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

  // Drag & drop
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

  const otherDevices = devices.filter((d) => d.id !== deviceId);
  const platformInfo = getDevicePlatform();

  return (
    <main className={styles.container}>
      <div className={styles.shell}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.brand}>
            <div className={styles.logoIcon}>⚡</div>
            <div>
              <h1 className={styles.brandTitle}>SlideDrop</h1>
              <p className={styles.brandSubtitle}>Direct cross-device file & text transfer</p>
            </div>
          </div>

          <div className={styles.headerActions}>
            <div
              className={`${styles.statusBadge} ${
                connectionState === "PEER_CONNECTED"
                  ? styles.statusP2P
                  : connectionState === "WAITING_FOR_DEVICE"
                  ? styles.statusWaiting
                  : connectionState === "CONNECTING"
                  ? styles.statusConnecting
                  : styles.statusDisconnected
              }`}
              onClick={() => setShowDiagnostics(true)}
              style={{ cursor: "pointer" }}
              title="Click to view connection diagnostics"
            >
              <span className={styles.statusDot} />
              {connectionState === "PEER_CONNECTED"
                ? `🟢 Peer Connected (${connectedPeerIds.length} P2P)`
                : connectionState === "WAITING_FOR_DEVICE"
                ? `Waiting for device (Channel: ${channelCode})`
                : connectionState === "CONNECTING"
                ? "Connecting…"
                : "Disconnected"}
            </div>

            <button className={styles.secondaryBtn} onClick={copyShareLink}>
              🔗 Share Link
            </button>
          </div>
        </header>

        {/* Notice Banner */}
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

        {/* Device & Channel Toolbar */}
        <section className={styles.deviceCard}>
          <div className={styles.deviceCardHeader}>
            <h2 className={styles.sectionTitle}>
              <span>Connected Devices ({devices.length || 1})</span>
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

            {/* Remote Devices */}
            {otherDevices.map((remote) => {
              const isP2P = connectedPeerIds.includes(remote.id);
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
                >
                  <div className={styles.deviceItemContent}>
                    <div className={styles.deviceIcon}>{icon}</div>
                    <div className={styles.deviceMeta}>
                      <p className={styles.deviceName}>{remote.name}</p>
                      <p className={styles.deviceSub}>
                        <span className={styles.onlineIndicator} />
                        {isP2P ? "🟢 WebRTC P2P Ready" : "Ready to receive"}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Device Rename Controls */}
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

            {/* Recipient Selector */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>
                <span>Send To</span>
                <span className={styles.fieldHint}>
                  {recipient === "all" ? "Broadcasting to channel" : "Direct to selected peer"}
                </span>
              </label>
              <select
                className={styles.selectInput}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              >
                <option value="all">📢 All Devices in Channel ({otherDevices.length})</option>
                {otherDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.type}) {connectedPeerIds.includes(d.id) ? "⚡ P2P" : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* Text Note Transfer */}
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
                    className={styles.fileRemoveBtn}
                    onClick={() => {
                      setSelectedFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}

              {transferProgress !== null && (
                <div>
                  <p style={{ fontSize: "12px", color: "#2563eb", fontWeight: 600, marginTop: "6px" }}>
                    {transferStatusText}
                  </p>
                  <div className={styles.progressBarContainer}>
                    <div className={styles.progressBarFill} style={{ width: `${transferProgress}%` }} />
                  </div>
                </div>
              )}

              <button
                className={`${styles.primaryBtn} ${styles.sendBtn}`}
                disabled={!selectedFile || transferProgress !== null}
                onClick={handleSendFile}
              >
                {transferProgress !== null ? "Transferring…" : "🚀 Upload & Send File"}
              </button>
            </div>
          </section>

          {/* Transfer History Panel */}
          <section className={styles.panel}>
            <div className={styles.panelTitle}>
              <span>📥 Transfer History</span>
              {transfers.length > 0 && (
                <button
                  className={styles.secondaryBtn}
                  style={{ fontSize: "11.5px", padding: "4px 8px" }}
                  onClick={clearHistory}
                >
                  Clear All
                </button>
              )}
            </div>

            {transfers.length === 0 ? (
              <div className={styles.historyEmpty}>
                <div className={styles.historyEmptyIcon}>📬</div>
                <p style={{ fontWeight: 600, color: "#475569" }}>No transfers yet</p>
                <p style={{ fontSize: "13px" }}>
                  Sent and received files or text notes will appear here automatically.
                </p>
              </div>
            ) : (
              <div className={styles.historyList}>
                {transfers.map((item) => {
                  const isText = Boolean(item.textContent);
                  return (
                    <div
                      key={item.id}
                      className={styles.historyItem}
                      onClick={() => handleTransferAction(item)}
                      style={{ cursor: "pointer" }}
                    >
                      <div className={styles.historyLeft}>
                        <div
                          className={`${styles.historyTypeIcon} ${
                            isText ? styles.historyIconText : styles.historyIconFile
                          }`}
                        >
                          {isText ? "💬" : "📄"}
                        </div>
                        <div className={styles.historyDetails}>
                          <p className={styles.historyTitle}>{item.filename}</p>
                          <p className={styles.historySub}>
                            <span>{item.senderName}</span>
                            <span>→</span>
                            <span>{item.recipientName}</span>
                            <span>•</span>
                            <span>{formatBytes(item.size)}</span>
                            <span>•</span>
                            <span>{formatTime(item.createdAt)}</span>
                            {item.method === "p2p" && <span style={{ color: "#10b981", fontWeight: 700 }}>• P2P</span>}
                          </p>
                        </div>
                      </div>

                      <div className={styles.historyActions}>
                        <button
                          className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTransferAction(item);
                          }}
                        >
                          {isText
                            ? copiedId === item.id
                              ? "✓ Copied"
                              : "📋 Copy"
                            : "⬇️ Download"}
                        </button>
                        <button
                          className={styles.deleteBtn}
                          title="Delete transfer"
                          onClick={(e) => deleteTransfer(item.id, e)}
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Diagnostics & Connection Modal */}
        {showDiagnostics && (
          <div className={styles.modalBackdrop} onClick={() => setShowDiagnostics(false)}>
            <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHeader}>
                <h3 className={styles.modalTitle}>Connection Diagnostics</h3>
                <button className={styles.noticeClose} onClick={() => setShowDiagnostics(false)}>
                  ✕
                </button>
              </div>

              <div className={styles.modalContent}>
                <p>
                  <strong>Connection State:</strong>{" "}
                  {connectionState === "PEER_CONNECTED"
                    ? "🟢 WebRTC P2P Direct Connected"
                    : connectionState === "WAITING_FOR_DEVICE"
                    ? "🔵 Waiting for second device to join channel"
                    : connectionState === "CONNECTING"
                    ? "🟡 Connecting & signaling..."
                    : "🔴 Disconnected"}
                </p>
                <p>
                  <strong>Channel Code:</strong> <code>{channelCode}</code>
                </p>
                <p>
                  <strong>Local Device ID:</strong> <code>{deviceId}</code>
                </p>
                <p>
                  <strong>Connected Peers:</strong> <code>{connectedPeerIds.join(", ") || "None"}</code>
                </p>
                <p>
                  <strong>Discovered Channel Devices:</strong> <code>{devices.length}</code>
                </p>

                <div className={styles.codeSnippet}>
                  {connectionState === "PEER_CONNECTED"
                    ? "Direct WebRTC DataChannel is open! File and text transfers stream P2P with zero server storage."
                    : "Open this channel code on another device (or click Share Link) to establish a WebRTC P2P direct transfer connection."}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
                  <button
                    className={styles.secondaryBtn}
                    onClick={() => {
                      performHeartbeat();
                      setShowDiagnostics(false);
                    }}
                  >
                    🔄 Re-sync
                  </button>
                  <button className={styles.primaryBtn} onClick={() => setShowDiagnostics(false)}>
                    Done
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
