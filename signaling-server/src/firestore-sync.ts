import { firestore } from "./firebase";
import { WebSocket } from "ws";

interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  joinedAt: number;
}

export class FirestoreChannelSync {
  private channelCode: string;
  private unsubscribeMembers: (() => void) | null = null;
  private unsubscribeMessages: (() => void) | null = null;
  
  // Callbacks to server
  public onMemberAdded: (member: DeviceInfo) => void;
  public onMemberRemoved: (deviceId: string) => void;
  public onMessage: (msg: any) => void;
  
  private members = new Map<string, DeviceInfo>();

  constructor(
    channelCode: string, 
    onMemberAdded: (member: DeviceInfo) => void,
    onMemberRemoved: (deviceId: string) => void,
    onMessage: (msg: any) => void
  ) {
    this.channelCode = channelCode;
    this.onMemberAdded = onMemberAdded;
    this.onMemberRemoved = onMemberRemoved;
    this.onMessage = onMessage;
  }

  public start() {
    if (!firestore) return;

    // 1. Sync Members
    const membersRef = firestore.collection(`channels/${this.channelCode}/members`);
    this.unsubscribeMembers = membersRef.onSnapshot((snapshot: any) => {
      snapshot.docChanges().forEach((change: any) => {
        const data = change.doc.data() as DeviceInfo;
        const deviceId = change.doc.id;

        if (change.type === "added" || change.type === "modified") {
          this.members.set(deviceId, data);
          this.onMemberAdded(data);
        } else if (change.type === "removed") {
          this.members.delete(deviceId);
          this.onMemberRemoved(deviceId);
        }
      });
    }, (err: any) => {
      console.error(`[FirestoreSync] Error syncing members for ${this.channelCode}:`, err);
    });

    // 2. Sync Messages (Offers, Answers, ICE)
    const messagesRef = firestore.collection(`channels/${this.channelCode}/messages`);
    const now = Date.now(); // only listen to new messages
    
    this.unsubscribeMessages = messagesRef
      .where("createdAt", ">=", now)
      .onSnapshot((snapshot: any) => {
        snapshot.docChanges().forEach((change: any) => {
          if (change.type === "added") {
            const data = change.doc.data();
            this.onMessage(data);
            
            // Clean up message immediately after processing to save space
            change.doc.ref.delete().catch(() => {});
          }
        });
      }, (err: any) => {
        console.error(`[FirestoreSync] Error syncing messages for ${this.channelCode}:`, err);
      });
  }

  public stop() {
    if (this.unsubscribeMembers) this.unsubscribeMembers();
    if (this.unsubscribeMessages) this.unsubscribeMessages();
  }

  public async registerLocalDevice(device: DeviceInfo) {
    if (!firestore) return;
    try {
      await firestore.doc(`channels/${this.channelCode}/members/${device.id}`).set(device);
    } catch (err) {
      console.error(`[FirestoreSync] Failed to register device ${device.id}:`, err);
    }
  }

  public async unregisterLocalDevice(deviceId: string) {
    if (!firestore) return;
    try {
      await firestore.doc(`channels/${this.channelCode}/members/${deviceId}`).delete();
    } catch (err) {
      console.error(`[FirestoreSync] Failed to unregister device ${deviceId}:`, err);
    }
  }

  public async sendMessage(targetDeviceId: string, fromDeviceId: string, type: string, payload: any) {
    if (!firestore) return false;
    try {
      await firestore.collection(`channels/${this.channelCode}/messages`).add({
        targetDeviceId,
        fromDeviceId,
        type,
        payload,
        createdAt: Date.now()
      });
      return true;
    } catch (err) {
      console.error(`[FirestoreSync] Failed to send message to ${targetDeviceId}:`, err);
      return false;
    }
  }

  public getAllMembers(): DeviceInfo[] {
    return Array.from(this.members.values());
  }
}
