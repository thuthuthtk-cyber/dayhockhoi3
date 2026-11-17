import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import {
  app as defaultApp,
  analytics as defaultAnalytics,
  db as defaultDb,
  auth as defaultAuth,
  isFirestoreQuotaExceeded,
  markFirestoreQuotaExceeded,
  resetFirestoreQuotaAndEnableNetwork,
  testFirestoreServerConnectionOnBoot
} from "./firebaseConfig";

export const firebaseConfig = {
  apiKey: (import.meta as any).env?.VITE_FIREBASE_API_KEY || "AIzaSyBReZ5OAXtkr1JAwQcyYni-UZKrqyjZ4Tw",
  authDomain: (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN || "hoctapkhoi3.firebaseapp.com",
  projectId: (import.meta as any).env?.VITE_FIREBASE_PROJECT_ID || "hoctapkhoi3",
  storageBucket: (import.meta as any).env?.VITE_FIREBASE_STORAGE_BUCKET || "hoctapkhoi3.firebasestorage.app",
  messagingSenderId: (import.meta as any).env?.VITE_FIREBASE_MESSAGING_SENDER_ID || "1030190205977",
  appId: (import.meta as any).env?.VITE_FIREBASE_APP_ID || "1:1030190205977:web:8826e16b125ef5edc9ee88",
  measurementId: (import.meta as any).env?.VITE_FIREBASE_MEASUREMENT_ID || "G-PZW8Y0FB2J"
};

export const app = defaultApp || (getApps().length > 0 ? getApp() : initializeApp(firebaseConfig));
export const analytics = defaultAnalytics;
export const db = defaultDb || getFirestore(app);
export const auth = defaultAuth || getAuth(app);

export {
  isFirestoreQuotaExceeded,
  markFirestoreQuotaExceeded,
  resetFirestoreQuotaAndEnableNetwork,
  testFirestoreServerConnectionOnBoot
};

export default app;
