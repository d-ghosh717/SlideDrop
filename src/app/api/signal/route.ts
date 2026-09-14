import { NextRequest, NextResponse } from "next/server";
import { pullSignals, pushSignal, SignalPayload } from "@/lib/server-state";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel");
  const deviceId = url.searchParams.get("deviceId");
  const since = parseInt(url.searchParams.get("since") || "0", 10);

  if (!channel || !deviceId) {
    return NextResponse.json({ success: false, error: "Missing channel or deviceId" }, { status: 400 });
  }

  const signals = pullSignals(channel, deviceId, since);
  return NextResponse.json({ success: true, signals });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<SignalPayload>;
    if (!body.channelCode || !body.senderDeviceId || !body.recipientDeviceId || !body.type || !body.data) {
      return NextResponse.json(
        { success: false, error: "Missing required signaling fields" },
        { status: 400 }
      );
    }

    const signal: SignalPayload = {
      id: "sig_" + Math.random().toString(36).substring(2, 10),
      channelCode: body.channelCode.toUpperCase(),
      senderDeviceId: body.senderDeviceId,
      recipientDeviceId: body.recipientDeviceId,
      type: body.type,
      data: body.data,
      timestamp: Date.now(),
    };

    pushSignal(signal);
    return NextResponse.json({ success: true, signalId: signal.id });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Invalid payload" },
      { status: 500 }
    );
  }
}
