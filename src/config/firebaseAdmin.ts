import admin from 'firebase-admin';
import { env } from './env';

let firebaseApp: admin.app.App | null = null;

function getFirebaseProjectId(): string | undefined {
  return env.FIREBASE_PROJECT_ID || env.FCM_PROJECT_ID;
}

function getFirebaseClientEmail(): string | undefined {
  return env.FIREBASE_CLIENT_EMAIL || env.FCM_CLIENT_EMAIL;
}

function getFirebasePrivateKey(): string | undefined {
  return env.FIREBASE_PRIVATE_KEY || env.FCM_PRIVATE_KEY;
}

export function getFirebaseAdminApp(): admin.app.App | null {
  const projectId = getFirebaseProjectId();
  const clientEmail = getFirebaseClientEmail();
  const privateKey = getFirebasePrivateKey();

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  if (!firebaseApp) {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    });
  }

  return firebaseApp;
}

export async function verifyFirebaseIdToken(idToken: string) {
  const app = getFirebaseAdminApp();
  if (!app) {
    throw new Error('Firebase Admin is not configured');
  }

  return admin.auth(app).verifyIdToken(idToken, true);
}
