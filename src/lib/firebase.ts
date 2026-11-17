import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAnalytics, isSupported, Analytics } from 'firebase/analytics';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  getDoc, 
  setDoc, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  serverTimestamp,
  getDocFromServer
} from 'firebase/firestore';

export const firebaseConfig = {
  apiKey: "AIzaSyBReZ5OAXtkr1JAwQcyYni-UZKrqyjZ4Tw",
  authDomain: "hoctapkhoi3.firebaseapp.com",
  projectId: "hoctapkhoi3",
  storageBucket: "hoctapkhoi3.firebasestorage.app",
  messagingSenderId: "1030190205977",
  appId: "1:1030190205977:web:8826e16b125ef5edc9ee88",
  measurementId: "G-PZW8Y0FB2J"
};

// Initialize Firebase App
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export let analytics: Analytics | null = null;
if (typeof window !== 'undefined') {
  isSupported()
    .then((supported) => {
      if (supported) {
        analytics = getAnalytics(app);
      }
    })
    .catch(() => {});
}

// Initialize Cloud Firestore & Auth
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  return errInfo;
}

// Google Sign-In helper
export const loginWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;

    // Check or create user document in `users` collection
    const userRef = doc(db, 'users', user.uid);
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      // First user / admin check (thuthuthtk@gmail.com or first user -> Admin, else Teacher)
      const isAdminEmail = user.email?.toLowerCase().includes('thuthuth') || user.email?.toLowerCase().includes('admin');
      const defaultRole = isAdminEmail ? 'admin' : 'teacher';

      await setDoc(userRef, {
        uid: user.uid,
        displayName: user.displayName || 'Người dùng mới',
        email: user.email || '',
        role: defaultRole,
        ownerId: user.uid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    return user;
  } catch (error: any) {
    console.error('Google Sign-In Error:', error);
    throw error;
  }
};

// Logout helper
export const logoutUser = () => signOut(auth);

// Generic Firestore Realtime Subscription helper for the 7 required collections:
// students, lessons, questions, exams, assignments, users, activities
export const subscribeToCollection = <T>(
  collectionName: 'students' | 'lessons' | 'questions' | 'exams' | 'assignments' | 'users' | 'activities',
  onUpdate: (data: T[]) => void,
  onError: (err: FirestoreErrorInfo) => void
) => {
  const colRef = collection(db, collectionName);
  
  return onSnapshot(colRef, (snapshot) => {
    const items = snapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    })) as T[];
    onUpdate(items);
  }, (error) => {
    const errObj = handleFirestoreError(error, OperationType.LIST, collectionName);
    onError(errObj);
  });
};

// Generic Document Writer with mandatory ownerId, createdAt, updatedAt
export const saveFirestoreDoc = async (
  collectionName: string,
  docId: string | null,
  data: Record<string, any>
) => {
  const currentUid = auth.currentUser?.uid || 'system_guest';
  const now = new Date().toISOString();

  const payload = {
    ...data,
    ownerId: data.ownerId || currentUid,
    updatedAt: now,
    ...(docId ? {} : { createdAt: now })
  };

  try {
    if (docId) {
      const docRef = doc(db, collectionName, docId);
      await updateDoc(docRef, payload);
      return docId;
    } else {
      const colRef = collection(db, collectionName);
      const res = await addDoc(colRef, payload);
      return res.id;
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, collectionName);
    throw error;
  }
};
