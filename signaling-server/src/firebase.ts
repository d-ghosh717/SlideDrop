import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import * as dotenv from "dotenv";

dotenv.config();

let db: Firestore | null = null;

try {
  // If FIREBASE_SERVICE_ACCOUNT is provided as a JSON string, parse and use it
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({
      credential: cert(serviceAccount),
    });
    console.log("[Firebase] Initialized using FIREBASE_SERVICE_ACCOUNT");
  } 
  // Otherwise try default initialization (relies on GOOGLE_APPLICATION_CREDENTIALS)
  else {
    initializeApp();
    console.log("[Firebase] Initialized using default credentials");
  }

  db = getFirestore();
} catch (error) {
  console.warn("[Firebase] Failed to initialize Firebase Admin SDK. Cross-instance coordination will be disabled.");
  // We will run in purely local memory mode if Firebase fails to initialize
}

export const firestore = db;
