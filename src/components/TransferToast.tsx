"use client";

import React, { useEffect, useState } from "react";
import styles from "./TransferToast.module.css";
import {
  FileText,
  Image as ImageIcon,
  Film,
  File,
  MessageSquare,
  X,
  Check,
  Download
} from "lucide-react";
import type { Transfer } from "@/lib/types";

export interface ToastItem {
  id: string;
  transfer: Transfer;
  receivedAt: number;
}

interface TransferToastProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  onAction: (transfer: Transfer) => void;
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TransferToastContainer({ toasts, onDismiss, onAction }: TransferToastProps) {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div className={styles.toastContainer} aria-live="polite">
      {toasts.slice(0, 3).map((item) => (
        <SingleToast
          key={item.id}
          item={item}
          onDismiss={() => onDismiss(item.id)}
          onAction={() => onAction(item.transfer)}
        />
      ))}
    </div>
  );
}

function SingleToast({
  item,
  onDismiss,
  onAction,
}: {
  item: ToastItem;
  onDismiss: () => void;
  onAction: () => void;
}) {
  const [isExiting, setIsExiting] = useState(false);
  const { transfer } = item;
  const isText = Boolean(transfer.textContent);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onDismiss, 300);
    }, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExiting(true);
    setTimeout(onDismiss, 300);
  };

  const renderIcon = () => {
    if (isText) {
      return <MessageSquare size={20} color="#FFC857" />;
    }
    const mime = transfer.mimeType?.toLowerCase() || "";
    const name = transfer.filename?.toLowerCase() || "";
    const url = transfer.downloadUrl || transfer.fileData;

    if (mime.startsWith("image/") && url) {
      return (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={url} alt={transfer.filename} className={styles.thumbImg} />
      );
    }
    if (mime.startsWith("image/")) return <ImageIcon size={20} color="#60A5FA" />;
    if (mime.startsWith("video/")) return <Film size={20} color="#C084FC" />;
    if (mime.includes("pdf") || name.endsWith(".pdf")) return <FileText size={20} color="#F87171" />;
    return <File size={20} color="#FF9F1C" />;
  };

  return (
    <div
      className={`${styles.toastCard} ${isExiting ? styles.exiting : ""}`}
      onClick={onAction}
      role="button"
      tabIndex={0}
      title={isText ? "Click to copy text note" : "Click to download file"}
    >
      <div className={styles.toastProgress} style={{ animationDuration: "5000ms" }} />

      <div className={styles.thumbBox}>{renderIcon()}</div>

      <div className={styles.contentBox}>
        <div className={styles.headerRow}>
          <span className={styles.title}>
            {isText ? "New message received" : "New file received"}
          </span>
          <span className={styles.timestamp}>now</span>
        </div>

        {isText ? (
          <span className={styles.textQuote}>
            &ldquo;{transfer.textContent && transfer.textContent.length > 50
              ? transfer.textContent.slice(0, 50) + "…"
              : transfer.textContent}&rdquo;
          </span>
        ) : (
          <span className={styles.subtitle} title={transfer.filename}>
            {transfer.filename} ({formatSize(transfer.size)})
          </span>
        )}

        <div className={styles.metaRow}>
          <span>From <strong className={styles.metaHighlight}>{transfer.senderName || "Remote Device"}</strong></span>
          <span>•</span>
          <span>{transfer.method === "p2p" ? "Direct P2P" : "Secure Relay"}</span>
        </div>
      </div>

      <button
        className={styles.closeBtn}
        onClick={handleClose}
        title="Dismiss"
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
}
