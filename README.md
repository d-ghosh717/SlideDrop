# ⚡ SlideDrop

> **Private, high-speed cross-device file & text transfer powered by WebRTC P2P DataChannels, WebSocket signaling, and hybrid cloud fallback.**

Transfer text notes, snippets, documents, and large files directly between your devices (Mac, Windows, Linux, iPhone, Android) on the same Wi-Fi network or across the web with zero configuration.

---

## 🚀 Getting Started

Follow these steps to set up and run SlideDrop locally after cloning the repository.

### Prerequisites
- **Node.js**: `v20.0.0` or newer
- **npm**: `v10.0.0` or newer (comes with Node.js)
- **Git**

---

### 1. Clone the Repository

```bash
git clone https://github.com/d-ghosh717/SlideDrop.git
cd SlideDrop
```

---

### 2. Install Dependencies

Install the project **and** signaling server dependencies:

```bash
# Install main project dependencies
npm install

# Install signaling server dependencies
cd signaling-server
npm install
cd ..
```

---

### 3. Configure Environment Variables (`.env`)

SlideDrop includes a `.env.example` template with default configuration.

Create your local `.env.local` file by copying the example:

```bash
cp .env.example .env.local
```

#### What's in `.env.local`:
```env
# WebSocket Signaling Server (Optional — auto-derived if omitted)
# NEXT_PUBLIC_SIGNALING_URL=wss://signal.yourdomain.com

# Firebase Config (Optional — enables Cloud Relay fallback)
NEXT_PUBLIC_FIREBASE_API_KEY="your-api-key"
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="your-project.firebaseapp.com"
NEXT_PUBLIC_FIREBASE_PROJECT_ID="your-project-id"
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="your-project.appspot.com"
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="your-sender-id"
NEXT_PUBLIC_FIREBASE_APP_ID="your-app-id"
NEXT_PUBLIC_FIREBASE_DATABASE_URL="https://your-project-default-rtdb.firebaseio.com"

# Server-only (Optional for automated cleanup cron)
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
CRON_SECRET=
```

> [!TIP]
> SlideDrop's WebRTC P2P and WebSocket signaling engine work **out-of-the-box** without any Firebase setup. Adding your own Firebase project credentials enables optional cross-internet cloud storage relay when WebRTC P2P is unavailable.

---

### 4. Run the Development Server

#### Option A: Full Stack — Both Next.js + Signaling Server (Recommended)

This starts both the Next.js frontend and the WebSocket signaling server concurrently:

```bash
npm run dev:all
```

This runs:
- **Next.js** on `http://0.0.0.0:3000` (accessible from other devices on LAN)
- **Signaling Server** on `ws://0.0.0.0:3001`

#### Option B: Run Services Separately

```bash
# Terminal 1: Signaling Server
npm run server

# Terminal 2: Next.js Frontend
npm run dev -- -H 0.0.0.0
```

#### Option C: Local Testing Only (Same Machine / Browser Tabs)
```bash
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

> [!IMPORTANT]
> For testing between two physical devices (phones, tablets, laptops), you **must** use Option A or B and access the app via your LAN IP (not `localhost`).

---

### 5. Testing Between Physical Devices

1. Start both servers with `npm run dev:all`
2. Find your host machine's local LAN IP:
   ```bash
   # macOS / Linux
   ifconfig | grep "inet " | grep -v 127.0.0.1

   # Windows
   ipconfig
   ```
3. On **Device A** (host): Open `http://localhost:3000`
4. On **Device B** (phone/second computer): Open `http://<YOUR_LAN_IP>:3000`
   - Example: `http://192.168.1.50:3000` or `http://10.64.35.86:3000`
5. On Device B, enter Device A's **Channel Code** and click **Join**

> [!NOTE]
> `localhost` on Device A refers to Device A itself. The second device **must** navigate to the host machine's LAN IP, not `localhost`.

---

### 6. Production Build

To test or deploy an optimized production build:

```bash
# Build the signaling server
npm run server:build

# Build the Next.js production bundle
npm run build

# Start both in production
npm run start          # Next.js on port 3000
npm run server:start   # Signaling server on port 3001
```

---

## 📖 How to Use SlideDrop

1. **Open Device A**:
   - Open SlideDrop in your browser. You will see a unique 6-character Channel Code (e.g. `BSQVH8`).
   - You can give your device a custom name (e.g. `MacBook Pro`, `Studio Workstation`).

2. **Connect Device B**:
   - Open SlideDrop on your phone or second computer.
   - Enter the Channel Code (e.g. `BSQVH8`) into the **Join Code** input and click **Join** (or click **Share Link** on Device A).

3. **Instant Peer-to-Peer Transfer**:
   - Both devices immediately detect each other (`🟢 P2P Connected`).
   - **Send Text / Links / Code**: Type in the text box and click **Send Text Note** (or press `Cmd+Enter` / `Ctrl+Enter`).
   - **Send Files**: Drag and drop any file (PDF, image, video, ZIP) into the dropzone or click to browse. Files are chunked in 16 KB blocks and stream directly over WebRTC DataChannel with live progress.
   - **1-Click Copy & Download**: Received items appear instantly in Transfer History with 1-click clipboard copy or direct file download.

---

## 🛠️ Architecture & Tech Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Frontend & UI** | Next.js 16 (App Router), React 19, CSS Modules | Responsive, glassmorphic UI with drag-and-drop dropzone |
| **P2P Transfer** | WebRTC `RTCDataChannel` | Zero-server direct transmission with 16KB chunking & backpressure |
| **Signaling & Presence** | WebSocket Server (`signaling-server/`) | Lightweight Node.js + `ws` server for channel membership, device discovery, presence, and WebRTC SDP/ICE relay |
| **Cloud Fallback** | Firebase Auth (Anonymous), Firestore, Storage | Cloud storage relay when WebRTC P2P is unavailable or across different networks |

### Architecture Diagram

```
┌──────────────┐     WebSocket      ┌────────────────────────┐     WebSocket      ┌──────────────┐
│   Device A   │ ◄──────────────► │  Signaling Server      │ ◄──────────────► │   Device B   │
│  (Browser)   │     (port 3001)   │  Channel / Presence    │     (port 3001)   │  (Browser)   │
│              │                    │  SDP / ICE Relay       │                    │              │
│              │                    └────────────────────────┘                    │              │
│              │                                                                  │              │
│              │ ◄───── Direct WebRTC P2P DataChannel (files/text) ─────────────► │              │
│              │                     (no server in path)                          │              │
└──────────────┘                                                                  └──────────────┘
```

---

## 📂 Project Structure

```
SlideDrop/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Main UI (React 19)
│   │   └── page.module.css       # Styles
│   └── lib/
│       ├── signaling-client.ts   # WebSocket client for signaling server
│       ├── webrtc.ts             # WebRTC peer connection & data channel manager
│       ├── transfer-manager.ts   # Dual-architecture transfer orchestrator (P2P + Cloud)
│       ├── firebase.ts           # Firebase client init (optional cloud fallback)
│       └── types.ts              # Shared TypeScript types
├── signaling-server/
│   ├── src/
│   │   └── server.ts            # WebSocket signaling server (Node.js + ws)
│   ├── package.json
│   └── tsconfig.json
├── package.json                  # Main project scripts
├── .env.example                  # Environment variable template
└── README.md
```

---

## 🚢 Deployment

### Vercel (Next.js Frontend)

1. Push your code to your GitHub repository:
   ```bash
   git push origin main
   ```
2. Import the project in [Vercel](https://vercel.com).
3. Add the `NEXT_PUBLIC_FIREBASE_*` and `NEXT_PUBLIC_SIGNALING_URL` environment variables in the Vercel Dashboard under **Project Settings > Environment Variables**.
4. Deploy!

### Signaling Server

The signaling server needs to be deployed separately (e.g. Railway, Fly.io, Render, or any Node.js host):

```bash
cd signaling-server
npm run build
npm run start
```

Set `NEXT_PUBLIC_SIGNALING_URL` in your Vercel env vars to point to your deployed signaling server (e.g. `wss://signal.yourdomain.com`).

---

## 📄 License

MIT License. Feel free to use and contribute!