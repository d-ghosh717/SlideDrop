import { NextRequest, NextResponse } from "next/server";
import { addRelayTransfer, getRelayTransfers, RelayTransfer } from "@/lib/server-state";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel");
  if (!channel) {
    return NextResponse.json({ success: false, error: "Missing channel code" }, { status: 400 });
  }

  const transfers = getRelayTransfers(channel);
  return NextResponse.json({ success: true, transfers });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<RelayTransfer>;
    if (!body.channelCode || !body.senderDeviceId || !body.filename) {
      return NextResponse.json(
        { success: false, error: "Missing required transfer fields" },
        { status: 400 }
      );
    }

    const transfer: RelayTransfer = {
      id: body.id || "rel_" + Math.random().toString(36).substring(2, 10),
      senderDeviceId: body.senderDeviceId,
      recipientDeviceId: body.recipientDeviceId || "all",
      channelCode: body.channelCode.toUpperCase(),
      senderName: body.senderName || "Unknown device",
      recipientName: body.recipientName || "All devices",
      filename: body.filename,
      mimeType: body.mimeType || "text/plain",
      size: body.size || 0,
      textContent: body.textContent,
      fileData: body.fileData,
      status: "completed",
      timestamp: Date.now(),
    };

    addRelayTransfer(transfer);
    return NextResponse.json({ success: true, transfer });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to save relay transfer" },
      { status: 500 }
    );
  }
}
