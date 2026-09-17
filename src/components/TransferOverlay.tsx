"use client";

import React, { useEffect, useState, useRef } from "react";
import styles from "./TransferOverlay.module.css";
import {
  Laptop,
  Smartphone,
  Check,
  AlertTriangle,
  FileText,
  Image as ImageIcon,
  Film,
  File,
  RotateCcw,
  X,
  ShieldCheck,
  Zap,
  Infinity as InfinityIcon,
  Lock
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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [etaText, setEtaText] = useState<string>("");
  const lastTimeRef = useRef<number>(Date.now());
  const lastBytesRef = useRef<number>(0);
  const speedRef = useRef<number>(0);

  // Stable ref for onClose to guarantee auto-close timer fires
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Real-time speed & ETA calculation
  useEffect(() => {
    if (!isOpen || (state !== "sending" && state !== "receiving")) {
      lastBytesRef.current = 0;
      setEtaText("");
      return;
    }

    const now = Date.now();
    const timeDelta = (now - lastTimeRef.current) / 1000;

    if (timeDelta >= 0.5) {
      const bytesDelta = transferredBytes - lastBytesRef.current;
      if (bytesDelta > 0) {
        const currentSpeed = bytesDelta / timeDelta;
        speedRef.current = speedRef.current === 0 ? currentSpeed : speedRef.current * 0.7 + currentSpeed * 0.3;
        const remainingBytes = Math.max(0, totalBytes - transferredBytes);
        if (speedRef.current > 0 && remainingBytes > 0) {
          const secondsLeft = Math.ceil(remainingBytes / speedRef.current);
          if (secondsLeft > 60) {
            setEtaText(`~${Math.ceil(secondsLeft / 60)}m left`);
          } else {
            setEtaText(`~${secondsLeft}s left`);
          }
        }
      }
      lastTimeRef.current = now;
      lastBytesRef.current = transferredBytes;
    }
  }, [isOpen, state, transferredBytes, totalBytes]);

  // CRITICAL FIX: Auto-close on completed state after 1.8 seconds reliably
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

  // Handle ESC key to dismiss completed or failed screens
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
  const transportLabel = transportMethod === "p2p" ? "Direct P2P" : "Secure Relay";

  // Dynamic titles
  const targetDevice = isSending ? (recipientName || "Remote Device") : (senderName || "Remote Device");

  return (
    <div
      className={styles.overlayBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="SlideDrop File Transfer"
    >
      {/* ==================================================
          PROCEDURAL SUBTLE ANIMATED BACKGROUND
          ================================================== */}
      <div className={styles.cosmicBg}>
        <div className={styles.orbitalGrid} />
        <div className={styles.ambientGlowLeft} />
        <div className={styles.ambientGlowRight} />
        <div className={styles.particleLayer}>
          <div className={styles.particle} />
          <div className={styles.particle} />
          <div className={styles.particle} />
          <div className={styles.particle} />
          <div className={styles.particle} />
          <div className={styles.particle} />
          <div className={styles.particle} />
          <div className={styles.particle} />
        </div>
      </div>

      {/* Header Info */}
      {!isCompleted && !isFailed && (
        <header className={styles.headerSection}>
          <h1 className={styles.mainTitle}>
            {state === "preparing" ? "Connecting to " : isSending ? "Sending files to " : "Receiving files from "}
            <span className={styles.deviceHighlight}>{targetDevice}</span>
            ...
          </h1>
          <p className={styles.subtitle}>
            <span>{itemsSummary || "1 file"}</span>
            {totalBytes > 0 && (
              <>
                <span className={styles.subtitleDot}>•</span>
                <span>{formatSize(totalBytes)}</span>
              </>
            )}
            <span className={styles.subtitleDot}>•</span>
            <span>{transportLabel}</span>
          </p>
        </header>
      )}

      {/* Center Cinematic Stage */}
      {!isCompleted && !isFailed && (
        <main className={styles.stageContainer}>
          {/* Sender Node (Left: Laptop) */}
          <div className={styles.deviceNode}>
            <div className={styles.deviceBadge}>
              <Laptop size={14} color="#FF9F1C" />
              <span>{isSending ? (senderName || "MacBook") : (senderName || "Remote Device")}</span>
            </div>
            <div className={styles.laptopWrapper}>
              <div className={styles.laptopScreen}>
                {/* Embedded SlideDrop Logo on screen */}
                <svg width="24" height="24" viewBox="0 0 40 40" fill="none">
                  <rect x="6" y="11" width="22" height="6" rx="3" fill="#FF9F1C" />
                  <rect x="12" y="23" width="22" height="6" rx="3" fill="#FFC857" />
                </svg>
              </div>
              <div className={styles.laptopBase} />
            </div>
          </div>

          {/* Center Trajectory Stage */}
          <div className={styles.trajectoryStage}>
            {/* Plasma Trajectory Line */}
            <div className={styles.plasmaBeam} />

            {/* Traveling Frosted File Badges */}
            <div className={styles.travelFilesTrack}>
              <div className={styles.travelCard} title="Image Payload">
                <ImageIcon size={17} />
                <span>IMG</span>
              </div>
              <div className={styles.travelCard} title="PDF Document">
                <FileText size={17} />
                <span>PDF</span>
              </div>
              <div className={styles.travelCard} title="Video Payload">
                <Film size={17} />
                <span>VID</span>
              </div>
              <div className={styles.travelCard} title="Document Data">
                <File size={17} />
                <span>DOC</span>
              </div>
            </div>

            {/* Realistic SlideDrop Courier Capsule */}
            <div className={styles.capsuleRocket}>
              <div className={styles.ionThruster} />
              <div className={styles.courierCapsule}>
                <div className={styles.capsuleSeam} />
                <svg width="18" height="14" viewBox="0 0 36 36" fill="none" style={{ position: "relative", zIndex: 2 }}>
                  <path d="M6 13.5H23C24.4 13.5 25.5 12.4 25.5 11H9C7.6 11 6.5 12.1 6 13.5Z" fill="#FF9F1C" />
                  <path d="M30 22.5H13C11.6 22.5 10.5 23.6 10.5 25H27C28.4 25 29.5 23.9 30 22.5Z" fill="#FF6B35" />
                </svg>
                <div className={styles.capsuleSensorLens} />
              </div>
            </div>
          </div>

          {/* Destination Node (Right: Phone + Ambient Light Ring) */}
          <div className={styles.deviceNode}>
            <div className={styles.deviceBadge}>
              <Smartphone size={14} color="#FF9F1C" />
              <span>{isSending ? (recipientName || "VIVO") : (recipientName || "This Device")}</span>
            </div>
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div className={styles.receiverLightRing} />
              {/* Phone Model */}
              <div className={styles.phoneWrapper}>
                <svg width="20" height="20" viewBox="0 0 40 40" fill="none">
                  <rect x="6" y="11" width="22" height="6" rx="3" fill="#FF9F1C" />
                  <rect x="12" y="23" width="22" height="6" rx="3" fill="#FFC857" />
                </svg>
              </div>
            </div>
          </div>
        </main>
      )}

      {/* HUD Progress Control Bar */}
      {!isCompleted && !isFailed && (
        <div className={styles.hudSection}>
          <div className={styles.hudProgressRow}>
            <div className={styles.progressBarTrack}>
              <div
                className={styles.progressBarFill}
                style={{ width: `${displayPercent}%` }}
              />
            </div>
            <div className={styles.percentLabel}>{displayPercent}%</div>
          </div>

          <div className={styles.hudMetaRow}>
            <span>
              {formatSize(transferredBytes)} / {formatSize(totalBytes || transferredBytes)}
            </span>
            {etaText && (
              <>
                <span className={styles.subtitleDot}>•</span>
                <span>{etaText}</span>
              </>
            )}
            <span className={styles.subtitleDot}>•</span>
            <span>{transportLabel}</span>
          </div>

          {onCancel && (
            <button
              className={styles.cancelTransferBtn}
              onClick={onCancel}
              type="button"
              aria-label="Cancel active transfer"
            >
              <X size={15} />
              <span>Cancel Transfer</span>
            </button>
          )}
        </div>
      )}

      {/* Completion View (Auto-Closes in 1.8s) */}
      {isCompleted && (
        <div className={styles.successStage}>
          <div className={styles.successBurstRings}>
            <div className={styles.burstRing1} />
            <div className={styles.burstRing2} />
            <div className={styles.successCircle}>
              <Check size={44} strokeWidth={3.5} />
            </div>
          </div>

          <h2 className={styles.successTitle}>Transfer Complete!</h2>
          <p className={styles.successSubtext}>
            {itemsSummary || "Files"} {totalBytes > 0 && `(${formatSize(totalBytes)})`}{" "}
            {isSending ? `sent to ${targetDevice}` : `received from ${targetDevice}`}
          </p>

          <div className={styles.travelFilesTrack} style={{ position: "static", transform: "none", gap: "12px" }}>
            <div className={styles.travelCard}><ImageIcon size={17} /><span>IMG</span></div>
            <div className={styles.travelCard}><FileText size={17} /><span>PDF</span></div>
            <div className={styles.travelCard}><Film size={17} /><span>VID</span></div>
            <div className={styles.travelCard}><File size={17} /><span>DOC</span></div>
          </div>

          {onClose && (
            <button
              className={styles.viewFilesBtn}
              onClick={() => {
                if (onCloseRef.current) onCloseRef.current();
              }}
              type="button"
            >
              View Files
            </button>
          )}
        </div>
      )}

      {/* Interrupted View */}
      {isFailed && (
        <div className={styles.interruptedStage}>
          <div className={styles.interruptedCapsule}>
            <AlertTriangle size={44} strokeWidth={2.8} />
          </div>

          <h2 className={styles.interruptedTitle}>Transfer Interrupted</h2>
          <p className={styles.interruptedSubtext}>
            {errorMessage || "Connection lost. Your files were not fully transferred."}
          </p>

          <div className={styles.interruptedActions}>
            {onRetry && isSending && (
              <button className={styles.retryBtn} onClick={onRetry} type="button">
                <RotateCcw size={15} />
                <span>Retry</span>
              </button>
            )}
            {onClose && (
              <button
                className={styles.cancelTransferBtn}
                onClick={() => {
                  if (onCloseRef.current) onCloseRef.current();
                }}
                type="button"
              >
                <X size={15} />
                <span>Close</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Ambient Side Tagline (Bottom Left) */}
      <div className={styles.ambientTagline}>
        <span>FAST</span>
        <span>PRIVATE</span>
        <span>BEAUTIFUL</span>
        <span className={styles.taglineSub}>— SLIDEDROP</span>
      </div>

      {/* Ambient Side Feature Badges (Bottom Right) */}
      <div className={styles.ambientFeatures}>
        <div className={styles.featureItem}>
          <div className={styles.featureIconBox}>
            <Lock size={12} />
          </div>
          <div>
            <div className={styles.featureTitle}>Secure &amp; Private</div>
            <div className={styles.featureDesc}>Direct P2P connection</div>
          </div>
        </div>
        <div className={styles.featureItem}>
          <div className={styles.featureIconBox}>
            <InfinityIcon size={12} />
          </div>
          <div>
            <div className={styles.featureTitle}>No File Size Limit</div>
            <div className={styles.featureDesc}>Share anything</div>
          </div>
        </div>
        <div className={styles.featureItem}>
          <div className={styles.featureIconBox}>
            <ShieldCheck size={12} />
          </div>
          <div>
            <div className={styles.featureTitle}>End-to-End Encrypted</div>
            <div className={styles.featureDesc}>Your files, your control</div>
          </div>
        </div>
      </div>
    </div>
  );
}
