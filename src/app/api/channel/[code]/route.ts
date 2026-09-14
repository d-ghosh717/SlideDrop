import { NextRequest, NextResponse } from "next/server";
import { getActiveDevices, registerDevice, removeDevice, ServerDevice } from "@/lib/server-state";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const devices = getActiveDevices(code);
  return NextResponse.json({ success: true, channel: code.toUpperCase(), devices });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  try {
    const body = (await request.json()) as Partial<ServerDevice>;
    if (!body.deviceId || !body.deviceName) {
      return NextResponse.json(
        { success: false, error: "Missing deviceId or deviceName" },
        { status: 400 }
      );
    }

    const device: ServerDevice = {
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      platform: body.platform || "browser",
      channelCode: code.toUpperCase(),
      lastSeen: Date.now(),
      online: true,
    };

    const devices = registerDevice(code, device);
    return NextResponse.json({ success: true, channel: code.toUpperCase(), devices });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Invalid payload" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const url = new URL(request.url);
  const deviceId = url.searchParams.get("deviceId");

  if (deviceId) {
    const devices = removeDevice(code, deviceId);
    return NextResponse.json({ success: true, channel: code.toUpperCase(), devices });
  }

  return NextResponse.json({ success: false, error: "Missing deviceId" }, { status: 400 });
}
