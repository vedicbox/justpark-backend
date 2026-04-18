import admin from 'firebase-admin';
import { getFirebaseAdminApp } from '../config/firebaseAdmin';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// Send push to one or many device tokens
// ─────────────────────────────────────────────
export async function sendPush(
  tokens:  string[],
  title:   string,
  body:    string,
  data?:   Record<string, string>
): Promise<void> {
  if (!tokens.length) return;

  const app = getFirebaseAdminApp();
  if (!app) {
    logger.warn({ msg: 'FCM not configured — push skipped' });
    return;
  }

  const messaging = admin.messaging(app);

  // Batch into chunks of 500 (FCM limit)
  const CHUNK = 500;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    const message: admin.messaging.MulticastMessage = {
      tokens: chunk,
      notification: { title, body },
      ...(data && { data }),
      android: {
        priority:     'high',
        notification: { sound: 'default' },
      },
      apns: {
        payload: { aps: { sound: 'default' } },
      },
    };

    try {
      const response = await messaging.sendEachForMulticast(message);
      if (response.failureCount > 0) {
        logger.warn({
          msg:          'FCM partial failure',
          failureCount: response.failureCount,
          successCount: response.successCount,
        });
      }
    } catch (err) {
      logger.error({ msg: 'FCM send error', err });
    }
  }
}
