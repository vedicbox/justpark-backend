import twilio from 'twilio';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// Twilio client — lazy singleton
// ─────────────────────────────────────────────
let twilioClient: ReturnType<typeof twilio> | null = null;

function getTwilioClient() {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
    return null;
  }
  if (!twilioClient) {
    twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

// ─────────────────────────────────────────────
// Send SMS — critical events only
// ─────────────────────────────────────────────
export async function sendSms(to: string, body: string): Promise<void> {
  const client = getTwilioClient();
  if (!client) {
    logger.warn({ msg: 'Twilio not configured — SMS skipped', to });
    return;
  }
  try {
    await client.messages.create({
      from: env.TWILIO_PHONE_NUMBER!,
      to,
      body,
    });
  } catch (err) {
    logger.error({ msg: 'Twilio send error', to, err });
  }
}
