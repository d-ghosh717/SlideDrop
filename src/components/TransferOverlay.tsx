"use client";

import React, { useEffect } from "react";
import styles from "./TransferOverlay.module.css";
import {
  ArrowRight,
  Zap,
  Cloud,
  Check,
  AlertTriangle,
  FileText,
  Image as ImageIcon,
  Film,
  File,
  Send,
  DownloadCloud
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
  // Auto-close on completed state after 1.8 seconds
  useEffect(() => {
    if (state === "completed" && isOpen && onClose) {
      const timer = setTimeout(() => {
        onClose();
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [state, isOpen, onClose]);

  if (!isOpen) return null;

  const isCompleted = state === "completed";
  const isFailed = state === "failed" || state === "cancelled";
  const isSending = direction === "send";
  const displayPercent = Math.min(100, Math.max(0, Math.round(percent)));

  const badgeText = isCompleted
    ? "Transfer Complete"
    : isFailed
    ? state === "cancelled"
      ? "Transfer Cancelled"
      : "Transfer Interrupted"
    : state === "preparing"
    ? "Preparing Transfer..."
    : state === "verifying"
    ? "Verifying Integrity..."
    : isSending
    ? "Launching Transfer..."
    : "Receiving Data...";

  return (
    <div
      className={styles.overlayBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="File Transfer In Progress"
    >
      <div className={styles.ambientGlow} />

      <div className={styles.overlayCard}>
        {/* Status Badge */}
        <div
          className={`${styles.statusBadge} ${
            isCompleted ? styles.completed : isFailed ? styles.failed : ""
          }`}
        >
          {isCompleted ? (
            <Check size={14} strokeWidth={3} />
          ) : isFailed ? (
            <AlertTriangle size={14} strokeWidth={2.5} />
          ) : isSending ? (
            <Send size={13} />
          ) : (
            <DownloadCloud size={13} />
          )}
          <span>{badgeText}</span>
        </div>

        {/* Sender -> Recipient Header */}
        <h2 className={styles.routeTitle}>
          <span>{senderName || "This Device"}</span>
          <ArrowRight size={18} className={styles.routeArrow} />
          <span>{recipientName || "Remote Device"}</span>
        </h2>

        {/* Item Summary Subtitle */}
        <p className={styles.fileSummarySubtext}>
          {itemsSummary}
          {totalBytes > 0 && ` • ${formatSize(totalBytes)}`}
        </p>

        {/* Visual Stage */}
        <div className={styles.animationStage}>
          {isCompleted ? (
            <div className={styles.successCheckCircle}>
              <Check size={48} strokeWidth={3.5} />
            </div>
          ) : isFailed ? (
            <div className={styles.failedCircle}>
              <AlertTriangle size={44} strokeWidth={3} />
            </div>
          ) : (
            <>
              {/* Receiver Portal Rings */}
              {!isSending && (
                <>
                  <div className={styles.portalRing} />
                  <div className={styles.portalGlow} />
                </>
              )}

              {/* Sender Launch Pad */}
              {isSending && <div className={styles.launchPad} />}

              {/* Futuristic Capsule Vehicle */}
              <div
                className={`${styles.capsuleWrapper} ${
                  isSending ? styles.sending : styles.receiving
                }`}
              >
                <div className={styles.capsuleBody}>
                  <div className={styles.capsuleGlass}>
                    {transportMethod === "p2p" ? (
                      <Zap size={20} strokeWidth={2.5} />
                    ) : (
                      <Cloud size={20} strokeWidth={2.5} />
                    )}
                  </div>
                </div>
                {/* Thruster Flame on Send */}
                {isSending && <div className={styles.capsuleThruster} />}
              </div>

              {/* Floating File Badges */}
              <div className={styles.floatingFiles}>
                <div className={styles.floatingFileCard}>
                  <ImageIcon size={13} />
                  <span>Payload</span>
                </div>
                <div className={styles.floatingFileCard}>
                  <FileText size={13} />
                  <span>Data</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Progress & Real Byte Counters */}
        {!isCompleted && !isFailed && (
          <div className={styles.progressSection}>
            <div className={styles.progressInfoRow}>
              <span>{state === "verifying" ? "Checksum verification" : "Transferring"}</span>
              <span className={styles.percentDisplay}>{displayPercent}%</span>
            </div>

            <div className={styles.progressBarTrack}>
              <div
                className={styles.progressBarFill}
                style={{ width: `${displayPercent}%` }}
              />
            </div>

            <div className={styles.metaInfoRow}>
              <span>
                {formatSize(transferredBytes)} / {formatSize(totalBytes)}
              </span>
              <span className={styles.transportTag}>
                {transportMethod === "p2p" ? <Zap size={13} /> : <Cloud size={13} />}
                {transportMethod === "p2p" ? "Direct P2P" : "Secure Relay"}
              </span>
            </div>
          </div>
        )}

        {/* Error Details */}
        {isFailed && errorMessage && (
          <p style={{ color: "#FCA5A5", fontSize: 13.5, marginBottom: 20 }}>
            {errorMessage}
          </p>
        )}

        {/* Actions */}
        <div className={styles.actionRow}>
          {!isCompleted && !isFailed && onCancel && (
            <button
              className={styles.cancelBtn}
              onClick={onCancel}
              type="button"
            >
              Cancel Transfer
            </button>
          )}

          {isFailed && (
            <>
              {onRetry && isSending && (
                <button
                  className={styles.retryBtn}
                  onClick={onRetry}
                  type="button"
                >
                  Retry Transfer
                </button>
              )}
              {onClose && (
                <button
                  className={styles.cancelBtn}
                  onClick={onClose}
                  type="button"
                >
                  Dismiss
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
