export type DevicePresenceState =
  | "DISCOVERED"
  | "ONLINE"
  | "CONNECTING"
  | "P2P_CONNECTED"
  | "OFFLINE";

export type Device = {
  id: string;
  userId: string;
  accountId: string;
  name: string;
  type: "desktop" | "mobile" | "tablet" | "browser" | string;
  pairingCode: string;
  online: boolean;
  state?: DevicePresenceState;
  lastSeen: unknown;
  createdAt: unknown;
};

export type TransferMethod = "p2p" | "storage" | "broadcast";

export type TransferStatus = "pending" | "uploading" | "completed" | "expired" | "failed";

export type Transfer = {
  id: string;
  userId: string;
  accountId: string;
  senderDeviceId: string;
  recipientDeviceId: string; // "all" for channel broadcast or specific device ID
  senderName: string;
  recipientName: string;
  filename: string;
  mimeType: string;
  size: number;
  storagePath?: string;
  downloadUrl?: string;
  fileData?: string; // Data URL or Blob URL for direct transfers
  textContent?: string;
  status: TransferStatus;
  method: TransferMethod;
  createdAt: unknown;
  expiresAt: unknown;
};

export type SendTransferOptions = {
  recipientId: string; // "all" or specific device ID
  recipientName?: string;
  senderName: string;
  onProgress?: (percent: number) => void;
};
