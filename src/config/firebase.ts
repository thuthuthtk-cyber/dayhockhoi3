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
} from "../firebaseConfig";

export const firebaseConfig = {
  apiKey: "AIzaSyBReZ5OAXtkr1JAwQcyYni-UZKrqyjZ4Tw",
  authDomain: "hoctapkhoi3.firebaseapp.com",
  projectId: "hoctapkhoi3",
  storageBucket: "hoctapkhoi3.firebasestorage.app",
  messagingSenderId: "1030190205977",
  appId: "1:1030190205977:web:8826e16b125ef5edc9ee88",
  measurementId: "G-PZW8Y0FB2J"
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
