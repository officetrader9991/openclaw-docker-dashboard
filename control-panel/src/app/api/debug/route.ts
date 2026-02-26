import { NextResponse } from "next/server";
import { sendRequest } from "@/lib/wsGateway";

export const dynamic = "force-dynamic";

export async function GET() {
  const serviceId = "699fc90fce2815de5458ec23";
  const port = 18789;
  const token = "1P4oUTDER5LF3Ne2cG8Wv6tSX90HQ7up";

  try {
    const result = await sendRequest(serviceId, port, token, "config.get", {}, 15000);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ ok: false, error: message, stack }, { status: 500 });
  }
}
