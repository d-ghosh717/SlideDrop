export type Device = {
  id: string;
  userId: string;
  accountId: string;
  name: string;
  type: "desktop" | "mobile" | "tablet" | "browser" | string;
  pairingCode: string;
  online: boolean;
  lastSeen: unknown;
  createdAt: unknown;
};

export type Transfer = {
  id: string;
  userId: string;
  accountId: string;
  senderDeviceId: string;
  recipientDeviceId: string; // empty string or "all" for broadcast
  senderName: string;
  recipientName: string;
  filename: string;
  mimeType: string;
  size: number;
  storagePath?: string;
  downloadUrl?: string;
  fileData?: string; // Base64 data URL for direct/P2P transfers
  textContent?: string;
  status: "pending" | "uploading" | "completed" | "expired" | "failed";
  method: "storage" | "p2p" | "broadcast";
  createdAt: unknown;
  expiresAt: unknown;
};

