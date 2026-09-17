"use client";

import React, { useEffect, useState, useRef } from "react";
import styles from "./TransferOverlay.module.css";
import {
  FileText,
  Image as ImageIcon,
  Film,
  File,
  Settings,
  Send,
  DownloadCloud,
  History,
  RotateCcw,
  X,
  Zap,
  Clock,
  Navigation,
  Check,
  AlertTriangle
} from "lucide-react";

export type TransferOverlayState =
  | "preparing"
  | "sending"
  | "receiving"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface TransferOverlayProps {
  isOpen: boolean;
  direction: "send" | "receive";
  state: TransferOverlayState;
  senderName: string;
  recipientName: string;
  itemsSummary: string;
  totalBytes: number;
  transferredBytes: number;
  percent: number;
  transportMethod: "p2p" | "storage";
  errorMessage?: string;
  onCancel?: () => void;
  onRetry?: () => void;
  onClose?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "32 MB/s";
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(0)} MB/s`;
}

function formatRemainingTime(seconds: number): string {
  if (seconds <= 0) return "00:00:01 remaining";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)} remaining`;
}

/* ==================================================
   REALISTIC SLIDEDROP SVG ROCKET
   Always points FORWARD to the Right (Towards Destination)
   With Exhaust Trailing on the Left (Behind toward Source)
   ================================================== */
function RealisticRocketSvg() {
  return (
    <svg
      width="100"
      height="40"
      viewBox="0 0 100 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        filter: "drop-shadow(0 0 14px rgba(255, 180, 50, 0.45))",
      }}
    >
      <defs>
        <linearGradient id="rocketBodyMetal" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#434B5C" />
          <stop offset="25%" stopColor="#252A36" />
          <stop offset="65%" stopColor="#141720" />
          <stop offset="100%" stopColor="#0B0D12" />
        </linearGradient>
        <linearGradient id="rocketGoldAccent" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#D97706" />
          <stop offset="50%" stopColor="#FFC857" />
          <stop offset="100%" stopColor="#FFE399" />
        </linearGradient>
        <linearGradient id="rocketCockpitGlass" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#090B10" />
          <stop offset="50%" stopColor="#1F2937" />
          <stop offset="100%" stopColor="#0F172A" />
        </linearGradient>
      </defs>

      {/* Top Swept Stabilizer Fin */}
      <path
        d="M16 16L8 5C7 4 10 3 13 4L32 15H16Z"
        fill="#181B24"
        stroke="#FFC857"
        strokeWidth="0.85"
        strokeOpacity="0.7"
      />

      {/* Bottom Swept Stabilizer Fin */}
      <path
        d="M16 24L8 35C7 36 10 37 13 36L32 25H16Z"
        fill="#181B24"
        stroke="#FFC857"
        strokeWidth="0.85"
        strokeOpacity="0.7"
      />

      {/* Main Aerodynamic Dark Metallic Fuselage */}
      <path
        d="M14 15C14 15 42 12 68 13C78 13.5 88 17.5 96 20C88 22.5 78 26.5 68 27C42 28 14 25 14 25L12 20L14 15Z"
        fill="url(#rocketBodyMetal)"
        stroke="#374151"
        strokeWidth="0.85"
      />

      {/* Specular Spine Highlight */}
      <path
        d="M18 15.5C40 13.5 64 14.5 78 17.5C66 16 40 15 18 15.5Z"
        fill="#FFFFFF"
        opacity="0.3"
      />

      {/* Gold Ring Band Accents */}
      <path
        d="M46 13.3C46 13.3 50 13.4 50 13.4C50 19 50 21 50 26.6C50 26.6 46 26.7 46 26.7Z"
        fill="url(#rocketGoldAccent)"
      />
      <path
        d="M66 14C66 14 69 14.3 69 14.3C69 19 69 21 69 25.7C69 25.7 66 26 66 26Z"
        fill="url(#rocketGoldAccent)"
      />

      {/* Golden Nose Cone */}
      <path
        d="M76 15.5C84 17 92 19 97 20C92 21 84 23 76 24.5C78.5 21.5 78.5 18.5 76 15.5Z"
        fill="url(#rocketGoldAccent)"
        stroke="#FFE399"
        strokeWidth="0.6"
      />

      {/* Cockpit Windshield */}
      <path
        d="M52 17.5C60 17 68 18 72 19.5C68 20 60 20 52 19.5V17.5Z"
        fill="url(#rocketCockpitGlass)"
        stroke="#FFC857"
        strokeWidth="0.6"
      />

      {/* Mid Stabilizer Wing */}
      <path
        d="M24 19L12 18L10 20L12 22L24 21Z"
        fill="#262C3A"
        stroke="#FFC857"
        strokeWidth="0.6"
      />

      {/* Propulsion Engine Nozzle */}
      <rect x="10" y="17.5" width="4" height="5" rx="1" fill="#FF9F1C" />
    </svg>
  );
}

export function TransferOverlay({
  isOpen,
  direction,
  state,
  senderName,
  recipientName,
  itemsSummary,
  totalBytes,
  transferredBytes,
  percent,
  transportMethod,
  errorMessage,
  onCancel,
  onRetry,
  onClose,
}: TransferOverlayProps) {
  // Speed & ETA estimation
  const [speed, setSpeed] = useState<number>(0);
  const [etaSeconds, setEtaSeconds] = useState<number>(18);
  const lastTimeRef = useRef<number>(Date.now());
  const lastBytesRef = useRef<number>(0);

  // Stable ref for auto-close to reliably trigger
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Real-time speed & countdown calculation
  useEffect(() => {
    if (!isOpen || (state !== "sending" && state !== "receiving")) {
      lastBytesRef.current = 0;
      return;
    }

    const now = Date.now();
    const timeDelta = (now - lastTimeRef.current) / 1000;

    if (timeDelta >= 0.4) {
      const bytesDelta = transferredBytes - lastBytesRef.current;
      if (bytesDelta > 0) {
        const currentSpeed = bytesDelta / timeDelta;
        setSpeed((prev) => (prev === 0 ? currentSpeed : prev * 0.6 + currentSpeed * 0.4));
        const remainingBytes = Math.max(0, totalBytes - transferredBytes);
        if (currentSpeed > 0 && remainingBytes > 0) {
          const secs = Math.ceil(remainingBytes / currentSpeed);
          setEtaSeconds(secs);
        }
      }
      lastTimeRef.current = now;
      lastBytesRef.current = transferredBytes;
    }
  }, [isOpen, state, transferredBytes, totalBytes]);

  // CRITICAL FIX: Auto-close overlay after 1.8 seconds on success
  useEffect(() => {
    if (state === "completed" && isOpen) {
      const timer = setTimeout(() => {
        if (onCloseRef.current) {
          onCloseRef.current();
        }
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [state, isOpen]);

  // ESC key listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen && (state === "completed" || state === "failed" || state === "cancelled")) {
        if (onCloseRef.current) onCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, state]);

  if (!isOpen) return null;

  const isCompleted = state === "completed";
  const isFailed = state === "failed" || state === "cancelled";
  const isSending = direction === "send";
  const displayPercent = Math.min(100, Math.max(0, Math.round(percent)));
  const transportLabel = transportMethod === "p2p" ? "Secure P2P Transfer" : "Secure Relay Transfer";

  // PHYSICAL DIRECTION RULE:
  // SOURCE is ALWAYS on the LEFT.
  // DESTINATION is ALWAYS on the RIGHT.
  // ROCKET ALWAYS TRAVELS LEFT -> RIGHT (Nose pointing Right, Exhaust on Left).
  const sourceDeviceName = isSending ? (senderName || "MacBook Air") : (senderName || "Remote Device");
  const sourceDeviceSub = isSending ? "You (Sender)" : "Sender";

  const destDeviceName = isSending ? (recipientName || "DESKTOP-7F3K2") : (recipientName || "This Device");
  const destDeviceSub = isSending ? "Receiving..." : "You (Capture Zone)";

  // Calculate rocket flight position along the trajectory (from 16% to 84%)
  const flightProgress = Math.min(100, Math.max(0, percent));
  const rocketLeftPercent = 16 + (flightProgress / 100) * 68;

  // Aerodynamic Banking Pitch angle along the curved arc
  // Ascending phase (0% - 40%): -3deg to 0deg | Descending phase (40% - 100%): 0deg to +3.5deg
  const calculatedPitch =
    flightProgress < 40
      ? -3.5 + (flightProgress / 40) * 3.5
      : ((flightProgress - 40) / 60) * 4.0;

  // Receiving Data Capture Zone threshold
  const isCaptureZoneActive = !isSending && flightProgress >= 65;

  // File Icon helper
  const renderIcon = () => {
    const summary = itemsSummary.toLowerCase();
    if (summary.endsWith(".png") || summary.endsWith(".jpg") || summary.endsWith(".jpeg") || summary.endsWith(".webp")) {
      return <ImageIcon size={20} />;
    }
    if (summary.endsWith(".mp4") || summary.endsWith(".mov") || summary.endsWith(".webm")) {
      return <Film size={20} />;
    }
    return <FileText size={20} />;
  };

  return (
    <div
      className={styles.overlayBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="SlideDrop File Transfer Experience"
    >
      {/* Sunlight Golden Atmosphere Flare */}
      <div className={styles.sunlightGlowRight} />

      {/* Top Header Bar */}
      <header className={styles.topNavBar}>
        <div className={styles.brandLeft}>
          <div className={styles.brandIcon}>
            <svg width="18" height="18" viewBox="0 0 36 36" fill="none">
              <path d="M8 13.5H23C24.4 13.5 25.5 12.4 25.5 11H9C7.6 11 6.5 12.1 8 13.5Z" fill="#0B0D12" />
              <path d="M28 22.5H13C11.6 22.5 10.5 23.6 10.5 25H27C28.4 25 29.5 23.9 28 22.5Z" fill="#0B0D12" />
            </svg>
          </div>
          <span className={styles.brandText}>SlideDrop</span>
        </div>

        <nav className={styles.navTabs}>
          <span className={`${styles.navTab} ${isSending ? styles.navTabActive : ""}`}>
            <Send size={14} />
            <span>Send</span>
          </span>
          <span className={`${styles.navTab} ${!isSending ? styles.navTabActive : ""}`}>
            <DownloadCloud size={14} />
            <span>Receive</span>
          </span>
          <span className={styles.navTab}>
            <History size={14} />
            <span>History</span>
          </span>
        </nav>

        <button className={styles.settingsBtn} title="Settings" aria-label="Settings">
          <Settings size={18} />
        </button>
      </header>

      {/* Main Title & Subtitle */}
      <div className={styles.titleSection}>
        <h1 className={styles.mainHeaderTitle}>
          {isCompleted
            ? "Transfer Complete"
            : isFailed
            ? "Transfer Interrupted"
            : isSending
            ? "Sending Files"
            : "Receiving Files"}
        </h1>
        <p className={styles.mainHeaderSubtitle}>
          {isCompleted
            ? `Delivered to ${destDeviceName}`
            : `${sourceDeviceName} → ${destDeviceName} • ${itemsSummary || "Files"}`}
        </p>
      </div>

      {/* Main Orbital Flight Stage */}
      <main className={styles.orbitalStage}>
        {/* Source Device (Left: Laptop / Sender) */}
        <div className={styles.deviceNode}>
          <div className={styles.orbitalRingsContainer}>
            <div className={styles.ring1} />
            <div className={styles.ring2} />
            <div className={styles.ring3} />
          </div>

          <div className={styles.deviceGraphicLaptop}>
            <div className={styles.laptopScreen}>
              <svg width="18" height="18" viewBox="0 0 36 36" fill="none">
                <rect x="6" y="11" width="22" height="5" rx="2.5" fill="#FF9F1C" />
                <rect x="11" y="21" width="22" height="5" rx="2.5" fill="#FFC857" />
              </svg>
            </div>
            <div className={styles.laptopBase} />
          </div>

          <p className={styles.deviceNameText}>{sourceDeviceName}</p>
          <p className={styles.deviceSubText}>{sourceDeviceSub}</p>
        </div>

        {/* Center Flight Track with Curved Trajectory & Realistic Forward Rocket */}
        <div className={styles.flightTrackArea}>
          {/* Curved SVG Trajectory Line & Active Data Stream Particles */}
          <svg className={styles.trajectorySvg} viewBox="0 0 900 200" preserveAspectRatio="none">
            {/* Glowing Base Halo */}
            <path
              d="M 50 140 Q 450 30 850 140"
              className={styles.trajectoryPathGlow}
            />
            {/* Base Dashed Line */}
            <path
              d="M 50 140 Q 450 30 850 140"
              className={styles.trajectoryPathBase}
            />
            {/* Active Flowing Data Stream Packets */}
            {!isCompleted && !isFailed && (
              <path
                d="M 50 140 Q 450 30 850 140"
                className={styles.dataStreamFlowPath}
              />
            )}
          </svg>

          {/* Traveling Forward Rocket with Aerodynamic Pitch & Particle Exhaust */}
          {!isCompleted && !isFailed && (
            <div
              className={styles.rocketPositioner}
              style={{
                left: `${rocketLeftPercent}%`,
                transform: `translate(-50%, -50%) rotate(${calculatedPitch}deg)`,
              }}
            >
              {/* Exhaust Jet Trail (Behind on Left) */}
              <div className={styles.exhaustJetTrail} />

              {/* Floating Payload Badge */}
              <div className={styles.payloadBadge} title={itemsSummary}>
                {renderIcon()}
              </div>

              {/* Realistic Aerospace Rocket (Facing Forward Right) */}
              <RealisticRocketSvg />
            </div>
          )}
        </div>

        {/* Destination Device (Right: Desktop Monitor / Receiver) */}
        <div className={styles.deviceNode}>
          {/* Distinctive Data Capture Field (Active on Receiving) */}
          <div
            className={`${styles.captureField} ${
              isCaptureZoneActive ? styles.captureFieldActive : ""
            }`}
          />

          <div className={styles.orbitalRingsContainer}>
            <div className={styles.ring1} />
            <div className={styles.ring2} />
            <div className={styles.ring3} />
          </div>

          <div className={styles.deviceGraphicMonitor}>
            <div className={styles.monitorScreen}>
              <svg width="18" height="18" viewBox="0 0 36 36" fill="none">
                <rect x="6" y="11" width="22" height="5" rx="2.5" fill="#FF9F1C" />
                <rect x="11" y="21" width="22" height="5" rx="2.5" fill="#FFC857" />
              </svg>
            </div>
            <div className={styles.monitorStand} />
            <div className={styles.monitorBase} />
          </div>

          <p className={styles.deviceNameText}>{destDeviceName}</p>
          <p className={styles.deviceSubText}>
            {isCompleted ? "Completed" : destDeviceSub}
          </p>
        </div>
      </main>

      {/* Bottom Center Transfer Information Card / Success / Interrupted */}
      <div className={styles.transferCardWrapper}>
        {/* Active Transfer Card */}
        {!isCompleted && !isFailed && (
          <div className={styles.transferCard}>
            <div className={styles.cardHeaderRow}>
              <div className={styles.fileIconBox}>{renderIcon()}</div>
              <div className={styles.fileDetails}>
                <span className={styles.fileName}>{itemsSummary || "project.zip"}</span>
                <span className={styles.fileSize}>{formatSize(totalBytes || transferredBytes)}</span>
              </div>
              {onCancel && (
                <button
                  className={styles.cancelActionBtn}
                  onClick={onCancel}
                  type="button"
                  aria-label="Cancel Transfer"
                >
                  <X size={14} />
                  <span>Cancel</span>
                </button>
              )}
            </div>

            <div className={styles.cardProgressRow}>
              <div className={styles.cardProgressTrack}>
                <div
                  className={styles.cardProgressFill}
                  style={{ width: `${displayPercent}%` }}
                />
              </div>
              <span className={styles.cardPercent}>{displayPercent}%</span>
            </div>

            <div className={styles.cardMetaRow}>
              <div className={styles.metaItem}>
                <Zap size={14} color="#FFC857" />
                <span className={styles.metaItemHighlight}>{formatSpeed(speed)}</span>
              </div>
              <div className={styles.metaItem}>
                <Clock size={14} color="#FFC857" />
                <span>{formatRemainingTime(etaSeconds)}</span>
              </div>
              <div className={styles.metaItem}>
                <Navigation size={14} color="#FFC857" />
                <span>{transportLabel}</span>
              </div>
            </div>
          </div>
        )}

        {/* Completed Celebration Card (Auto-closes in 1.8s) */}
        {isCompleted && (
          <div className={styles.successCard}>
            <div className={styles.successIconCircle}>
              <Check size={36} strokeWidth={3.5} />
            </div>
            <h2 className={styles.successHeading}>Transfer Complete!</h2>
            <p className={styles.successDetails}>
              {itemsSummary || "Files"} ({formatSize(totalBytes)}) {isSending ? `delivered to ${destDeviceName}` : `received from ${sourceDeviceName}`}
            </p>
          </div>
        )}

        {/* Interrupted Card */}
        {isFailed && (
          <div className={styles.interruptedCard}>
            <div className={styles.interruptedIconCircle}>
              <AlertTriangle size={34} strokeWidth={2.8} />
            </div>
            <h2 className={styles.interruptedHeading}>Transfer Interrupted</h2>
            <p style={{ color: "#9CA3AF", fontSize: "14px", margin: 0 }}>
              {errorMessage || "Connection lost. Your file was not fully transferred."}
            </p>
            <div className={styles.interruptedActionsRow}>
              {onRetry && isSending && (
                <button className={styles.retryBtn} onClick={onRetry} type="button">
                  <RotateCcw size={14} />
                  <span>Retry</span>
                </button>
              )}
              {onClose && (
                <button
                  className={styles.closeBtn}
                  onClick={() => {
                    if (onCloseRef.current) onCloseRef.current();
                  }}
                  type="button"
                >
                  <X size={14} />
                  <span>Close</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Bottom Tagline */}
        <p className={styles.bottomQuote}>&ldquo;Big files. Small distance.&rdquo;</p>
      </div>
    </div>
  );
}
