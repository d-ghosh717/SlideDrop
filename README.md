# SlideDrop

Private, direct cross-device text and file transfer built with Next.js and WebRTC P2P DataChannels, with server relay and Firebase fallback.

## Quick Start (Local & LAN Development)

### 1. Run the Development Server

To enable access from other physical devices (phones, tablets, laptops) on the same Wi-Fi network, bind Next.js to all network interfaces (`0.0.0.0`):

```bash
npm run dev -- -H 0.0.0.0
```

### 2. Accessing SlideDrop

- **On the host computer**: Open [http://localhost:3000](http://localhost:3000)
- **On another physical device (same Wi-Fi)**:
  Find your host machine's local LAN IP:
  ```bash
  # macOS / Linux
  ifconfig | grep "inet " | grep -v 127.0.0.1
  # Windows
  ipconfig
  ```
  Open `http://<YOUR_LAN_IP>:3000` (for example `http://10.64.35.86:3000` or `http://192.168.1.50:3000`) in the mobile browser.

> [!NOTE]
> `localhost` on Device A refers to Device A itself. When testing between two separate physical devices, Device B must use the host machine's LAN IP.

---

## How It Works

1. **Channel Discovery & Presence**:
   - Device A opens SlideDrop and gets an active channel code (e.g. `BSQVH8`).
   - Device B opens SlideDrop on the same or another computer/phone and enters `BSQVH8`.
   - Both devices immediately detect each other within 1 second and exchange presence heartbeats.

2. **Direct WebRTC P2P Transfer**:
   - The devices establish a direct `RTCDataChannel` via the local signaling relay using STUN servers.
   - Files are transferred in **16 KB chunks** with backpressure control (`bufferedamountlow`) and reassembled into verified Blobs on the receiving device.
   - Text notes and snippets stream with sub-millisecond latency.

3. **Hybrid Relay Fallback**:
   - If WebRTC P2P is blocked by restrictive firewalls or symmetric NAT, SlideDrop seamlessly routes transfers through the server relay / Firebase Storage with live progress reporting.

---

## Vercel & Firebase Deployment

Set the standard environment variables in `.env.local` or Vercel settings:
- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- `NEXT_PUBLIC_FIREBASE_DATABASE_URL`