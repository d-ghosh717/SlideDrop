import { WebSocket } from "ws";

const URL = process.env.SIGNALING_URL || "ws://localhost:3001";
const CHANNEL = "E2E" + Math.floor(1000 + Math.random() * 9000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestClient {
  ws: WebSocket;
  deviceId: string;
  deviceName: string;
  revision: number;
  members: unknown[];
  messages: unknown[];
  getMemberCount: () => number;
}

function createClient(deviceId: string, deviceName: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const client: TestClient = {
      ws,
      deviceId,
      deviceName,
      revision: 0,
      members: [],
      messages: [],
      getMemberCount() {
        return this.members.length;
      },
    };

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "join",
          channelCode: CHANNEL,
          deviceId,
          deviceName,
          platform: "desktop",
        })
      );
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        client.messages.push(msg);
        if (msg.type === "join_ack") {
          client.revision = msg.revision || 0;
          client.members = Array.isArray(msg.members) ? msg.members : [];
          resolve(client);
        } else if (msg.type === "members") {
          client.revision = msg.revision || 0;
          client.members = Array.isArray(msg.devices) ? msg.devices : [];
        }
      } catch (err) {
        console.warn("[TestClient] Parse error:", err);
      }
    });

    ws.on("error", (err) => {
      reject(err);
    });
  });
}

export async function runSignalingE2ETests(): Promise<void> {
  console.log(`Starting SlideDrop Signaling E2E Tests on channel [${CHANNEL}]...`);

  // TEST A: 4 Devices Join Simultaneously
  console.log("\n=== TEST A: 4 Devices Join Simultaneously ===");
  const [devA, devB, devC, devD] = await Promise.all([
    createClient("dev_mac_1", "MacBook"),
    createClient("dev_win_2", "Windows PC"),
    createClient("dev_iph_3", "iPhone"),
    createClient("dev_and_4", "Android Phone"),
  ]);

  await sleep(600);

  const countA: number = devA.getMemberCount();
  const countB: number = devB.getMemberCount();
  const countC: number = devC.getMemberCount();
  const countD: number = devD.getMemberCount();

  console.log(`Device A sees ${countA} peers (rev ${devA.revision})`);
  console.log(`Device B sees ${countB} peers (rev ${devB.revision})`);
  console.log(`Device C sees ${countC} peers (rev ${devC.revision})`);
  console.log(`Device D sees ${countD} peers (rev ${devD.revision})`);

  if (countA === 3 && countB === 3 && countC === 3 && countD === 3) {
    console.log("✅ TEST A PASSED: All 4 devices discover all 3 remote peers!");
  } else {
    throw new Error(`TEST A FAILED: Expected 3 peers each, got [${countA}, ${countB}, ${countC}, ${countD}]`);
  }

  // TEST B: Device D Leaves
  console.log("\n=== TEST B: Device D Leaves ===");
  devD.ws.close();
  await sleep(600);

  const countAAfterLeave: number = devA.getMemberCount();
  const countBAfterLeave: number = devB.getMemberCount();
  const countCAfterLeave: number = devC.getMemberCount();

  console.log(`Device A now sees ${countAAfterLeave} peers (rev ${devA.revision})`);
  console.log(`Device B now sees ${countBAfterLeave} peers (rev ${devB.revision})`);
  console.log(`Device C now sees ${countCAfterLeave} peers (rev ${devC.revision})`);

  if (countAAfterLeave === 2 && countBAfterLeave === 2 && countCAfterLeave === 2) {
    console.log("✅ TEST B PASSED: Remaining 3 devices see 2 peers immediately!");
  } else {
    throw new Error(`TEST B FAILED: Expected 2 peers each after leave, got [${countAAfterLeave}, ${countBAfterLeave}, ${countCAfterLeave}]`);
  }

  // TEST C: Device D Reconnects with same deviceId
  console.log("\n=== TEST C: Device D Reconnects with same deviceId ===");
  const devD2 = await createClient("dev_and_4", "Android Phone");
  await sleep(600);

  const countAAfterReconnect: number = devA.getMemberCount();
  const countDAfterReconnect: number = devD2.getMemberCount();

  console.log(`Device A sees ${countAAfterReconnect} peers (rev ${devA.revision})`);
  console.log(`Device D sees ${countDAfterReconnect} peers (rev ${devD2.revision})`);

  if (countAAfterReconnect === 3 && countDAfterReconnect === 3) {
    console.log("✅ TEST C PASSED: Reconnected device re-joins seamlessly and is visible to all!");
  } else {
    throw new Error(`TEST C FAILED: Expected 3 peers each after reconnect, got [${countAAfterReconnect}, ${countDAfterReconnect}]`);
  }

  // TEST D: Signaling Routing
  console.log("\n=== TEST D: Signaling Offer / Answer Routing ===");
  let offerReceived = false;
  devB.ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "offer" && msg.fromDeviceId === "dev_mac_1") {
        offerReceived = true;
      }
    } catch {}
  });

  devA.ws.send(
    JSON.stringify({
      type: "offer",
      targetDeviceId: "dev_win_2",
      fromDeviceId: "dev_mac_1",
      sdp: { type: "offer", sdp: "dummy-sdp-data" },
    })
  );

  await sleep(400);
  if (offerReceived) {
    console.log("✅ TEST D PASSED: WebRTC Offer signaling routed accurately to target device!");
  } else {
    throw new Error("TEST D FAILED: Offer not routed to peer!");
  }

  // Cleanup
  devA.ws.close();
  devB.ws.close();
  devC.ws.close();
  devD2.ws.close();

  console.log("\n🎉 ALL SIGNALING INTEGRATION TESTS PASSED PERFECTLY!");
}

// Auto-run when executed directly via tsx/node
if (typeof process !== "undefined" && process.argv[1]?.includes("test-e2e")) {
  runSignalingE2ETests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test execution failed:", err);
      process.exit(1);
    });
}
