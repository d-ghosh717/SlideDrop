import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function adminApp() {
  if (getApps().length) return getApps()[0];
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!process.env.FIREBASE_CLIENT_EMAIL || !privateKey || !process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || !process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) throw new Error("Firebase Admin cleanup credentials are not configured.");
  return initializeApp({ credential: cert({ projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey }), storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET });
}

export async function GET(request: NextRequest) {
  if (process.env.CRON_SECRET && request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const app = adminApp();
    const firestore = getFirestore(app);
    const bucket = getStorage(app).bucket();
    const snapshot = await firestore.collection("transfers").where("expiresAt", "<=", Timestamp.now()).limit(100).get();
    let deleted = 0;
    for (const item of snapshot.docs) {
      const storagePath = item.get("storagePath");
      if (storagePath) await bucket.file(storagePath).delete({ ignoreNotFound: true });
      await item.ref.delete();
      deleted += 1;
    }
    return NextResponse.json({ deleted });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cleanup failed" }, { status: 500 });
  }
}
