# ⚡ SlideDrop

> **Private, high-speed cross-device file & text transfer powered by WebRTC P2P DataChannels, real-time presence discovery, and hybrid cloud fallback.**

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

Install the project dependencies using npm:

```bash
npm install
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
# Public Firebase Config (Optional: SlideDrop works out-of-the-box via built-in WebRTC & signaling)
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
> SlideDrop's high-speed WebRTC P2P and local signaling engine work **out-of-the-box** without any additional setup. Adding your own Firebase project credentials enables optional cross-internet cloud storage persistence.

---

### 4. Run the Development Server

#### Option A: Local Testing (Same Machine / Browser Tabs)
```bash
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

#### Option B: Physical Device Testing (Phones, Tablets & Laptops on Same Wi-Fi)
To allow other devices on your local network to connect, bind the server to all network interfaces (`0.0.0.0`):

```bash
npm run dev -- -H 0.0.0.0
```

1. Find your host machine's local LAN IP:
   ```bash
   # macOS / Linux
   ifconfig | grep "inet " | grep -v 127.0.0.1

   # Windows
   ipconfig
   ```
2. Open `http://<YOUR_LAN_IP>:3000` (e.g. `http://192.168.1.50:3000` or `http://10.64.35.86:3000`) on your phone or second computer.

> [!NOTE]
> `localhost` on Device A refers to Device A itself. When testing between two physical devices (e.g. laptop and phone), the second device must navigate to the host machine's LAN IP.

---

### 5. Production Build

To test or deploy an optimized production build:

```bash
# Build the production bundle
npm run build

# Start the production server
npm run start
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
   - Both devices immediately detect each other (`🟢 Peer Connected (P2P Direct)`).
   - **Send Text / Links / Code**: Type in the text box and click **Send Text Note** (or press `Cmd+Enter` / `Ctrl+Enter`).
   - **Send Files**: Drag and drop any file (PDF, image, video, ZIP) into the dropzone or click to browse. Files are chunked in 16 KB blocks and stream directly over WebRTC DataChannel with live progress.
   - **1-Click Copy & Download**: Received items appear instantly in Transfer History with 1-click clipboard copy or direct file download.

---

## 🛠️ Architecture & Tech Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Frontend & UI** | Next.js 16 (App Router), React 19, CSS Modules | Responsive, glassmorphic UI with drag-and-drop dropzone |
| **P2P Transfer** | WebRTC `RTCDataChannel` | Zero-server direct transmission with 16KB chunking & backpressure |
| **Signaling & Presence** | Cloud Firestore (`channels/{code}/devices`, `channels/{code}/signals`) | Cross-device realtime presence heartbeat, SDP exchange, and ICE candidate delivery |
| **Cloud Fallback** | Firebase Auth (Anonymous), Firestore, Storage | Cloud storage relay when WebRTC P2P is establishing or as backup |

---

## 🚢 Deployment to Vercel

1. Push your code to your GitHub repository:
   ```bash
   git push origin main
   ```
2. Import the project in [Vercel](https://vercel.com).
3. Add the `NEXT_PUBLIC_FIREBASE_*` environment variables in the Vercel Dashboard under **Project Settings > Environment Variables**.
4. Deploy!

---

## 📄 License

MIT License. Feel free to use and contribute!