import * as sib from '@getbrevo/brevo';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// Brevo init
// ─────────────────────────────────────────────
const apiInstance = new sib.TransactionalEmailsApi();

if (env.BREVO_API_KEY) {
  apiInstance.setApiKey(sib.TransactionalEmailsApiApiKeys.apiKey, env.BREVO_API_KEY);
}

export interface EmailPayload {
  to:      string;
  subject: string;
  html:    string;
  text?:   string;
  replyTo?: string;
}

export interface EmailDeliveryResult {
  status: 'sent' | 'skipped' | 'failed';
  provider: 'brevo' | 'hostinger_smtp';
  reason?: string;
  providerMessageId?: string | null;
}

let supportTransporter: Transporter | null = null;

function isSupportSmtpConfigured(): boolean {
  return Boolean(env.SUPPORT_SMTP_USER && env.SUPPORT_SMTP_PASS);
}

function getSupportTransporter(): Transporter {
  if (!supportTransporter) {
    supportTransporter = nodemailer.createTransport({
      host: env.SUPPORT_SMTP_HOST,
      port: env.SUPPORT_SMTP_PORT,
      secure: env.SUPPORT_SMTP_SECURE,
      requireTLS: !env.SUPPORT_SMTP_SECURE,
      auth: {
        user: env.SUPPORT_SMTP_USER,
        pass: env.SUPPORT_SMTP_PASS,
      },
    });
  }

  return supportTransporter;
}

// ─────────────────────────────────────────────
// Send a single email
// ─────────────────────────────────────────────
export async function sendEmailWithResult(payload: EmailPayload): Promise<EmailDeliveryResult> {
  console.log('BREVO_API_KEY exists:', !!env.BREVO_API_KEY);
  console.log('EMAIL_FROM:', env.EMAIL_FROM);

  if (!env.BREVO_API_KEY) {
    logger.warn({ msg: 'Brevo not configured — email skipped', to: payload.to, subject: payload.subject });
    return { status: 'skipped', provider: 'brevo', reason: 'brevo_not_configured', providerMessageId: null };
  }
  try {
    const sendSmtpEmail = new sib.SendSmtpEmail();
    sendSmtpEmail.to = [{ email: payload.to }];
    sendSmtpEmail.sender = { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME };
    if (payload.replyTo) {
      sendSmtpEmail.replyTo = { email: payload.replyTo };
    }
    sendSmtpEmail.subject = payload.subject;
    sendSmtpEmail.htmlContent = payload.html;
    sendSmtpEmail.textContent = payload.text ?? payload.subject;

    const response = await apiInstance.sendTransacEmail(sendSmtpEmail) as { messageId?: string };
    const providerMessageId = response?.messageId ?? null;
    logger.info({
      msg: 'Email sent via Brevo',
      to: payload.to,
      subject: payload.subject,
      providerMessageId,
      brevoResponse: response,
    });
    return { status: 'sent', provider: 'brevo', providerMessageId };
  } catch (err) {
    logger.error({ msg: 'Brevo send error', err, to: payload.to, subject: payload.subject });
    return {
      status: 'failed',
      provider: 'brevo',
      reason: err instanceof Error ? err.message : 'brevo_send_failed',
      providerMessageId: null,
    };
  }
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  await sendEmailWithResult(payload);
}

export async function sendSupportEmailWithResult(payload: EmailPayload): Promise<EmailDeliveryResult> {
  if (!isSupportSmtpConfigured()) {
    logger.warn({ msg: 'Support SMTP not configured — email skipped', subject: payload.subject });
    return { status: 'skipped', provider: 'hostinger_smtp', reason: 'support_smtp_not_configured' };
  }

  try {
    const transporter = getSupportTransporter();
    await transporter.sendMail({
      from: {
        address: env.SUPPORT_EMAIL_FROM,
        name: env.SUPPORT_EMAIL_FROM_NAME,
      },
      to: payload.to,
      replyTo: payload.replyTo,
      subject: payload.subject,
      html: payload.html,
      text: payload.text ?? payload.subject,
    });

    logger.info({ msg: 'Support email sent via Hostinger SMTP', to: payload.to, subject: payload.subject });
    return { status: 'sent', provider: 'hostinger_smtp' };
  } catch (err) {
    logger.error({ msg: 'Support SMTP send error', err, to: payload.to, subject: payload.subject });
    return {
      status: 'failed',
      provider: 'hostinger_smtp',
      reason: err instanceof Error ? err.message : 'support_smtp_send_failed',
    };
  }
}

// ─────────────────────────────────────────────
// HTML Email Templates
// ─────────────────────────────────────────────

const baseTemplate = (content: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
    .container { max-width: 600px; margin: 32px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #1a73e8; padding: 24px 32px; }
    .header h1 { color: #fff; margin: 0; font-size: 22px; font-weight: 600; }
    .body { padding: 32px; color: #333; line-height: 1.6; }
    .body p { margin: 0 0 16px; }
    .cta { display: inline-block; margin-top: 8px; padding: 12px 24px; background: #1a73e8; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; }
    .detail-box { background: #f8f9fa; border-radius: 6px; padding: 16px 20px; margin: 20px 0; }
    .detail-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #eee; }
    .detail-row:last-child { border-bottom: none; }
    .footer { padding: 20px 32px; background: #f8f9fa; font-size: 12px; color: #888; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1 style="color:#1B4FD8;font-family:system-ui;font-weight:800;letter-spacing:-1px">Just<span style="color:#4B5563;font-weight:400">Park</span></h1></div>
    <div class="body">${content}</div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} JustPark. All rights reserved.<br />
      If you didn't request this email, please ignore it.
    </div>
  </div>
</body>
</html>
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function welcomeTemplate(firstName: string): EmailPayload {
  return {
    subject: 'Welcome to JustPark!',
    html: baseTemplate(`
      <p>Hi ${firstName},</p>
      <p>Welcome to <strong>JustPark</strong> — the easiest way to find and book parking spaces near you.</p>
      <p>You can now:</p>
      <ul>
        <li>Search thousands of parking spaces by location</li>
        <li>Book instantly or request approval from hosts</li>
        <li>Pay securely and manage your bookings in one place</li>
      </ul>
      <p>Ready to park?</p>
      <a class="cta" href="https://justpark.com/search">Find Parking</a>
    `),
    to: '', // caller sets to
  };
}

export function bookingConfirmationTemplate(opts: {
  firstName:   string;
  bookingId:   string;
  spaceName:   string;
  address:     string;
  startTime:   string;
  endTime:     string;
  totalPrice:  number;
  currency:    string;
}): Omit<EmailPayload, 'to'> {
  return {
    subject: `Booking Confirmed — ${opts.spaceName}`,
    html: baseTemplate(`
      <p>Hi ${opts.firstName},</p>
      <p>Your booking is <strong>confirmed</strong>! Here are your details:</p>
      <div class="detail-box">
        <div class="detail-row"><span>Space</span><strong>${opts.spaceName}</strong></div>
        <div class="detail-row"><span>Address</span><span>${opts.address}</span></div>
        <div class="detail-row"><span>Check-in</span><span>${opts.startTime}</span></div>
        <div class="detail-row"><span>Check-out</span><span>${opts.endTime}</span></div>
        <div class="detail-row"><span>Total Paid</span><strong>${opts.currency} ${opts.totalPrice.toFixed(2)}</strong></div>
        <div class="detail-row"><span>Booking ID</span><span>${opts.bookingId}</span></div>
      </div>
      <p>You'll receive a reminder 1 hour before your booking starts.</p>
      <a class="cta" href="https://justpark.com/bookings/${opts.bookingId}">View Booking</a>
    `),
  };
}

export function paymentReceiptTemplate(opts: {
  firstName:     string;
  bookingId:     string;
  amount:        number;
  currency:      string;
  paymentMethod: string;
  transactionId: string;
}): Omit<EmailPayload, 'to'> {
  return {
    subject: `Payment Receipt — ${opts.currency} ${opts.amount.toFixed(2)}`,
    html: baseTemplate(`
      <p>Hi ${opts.firstName},</p>
      <p>Your payment has been successfully processed.</p>
      <div class="detail-box">
        <div class="detail-row"><span>Amount</span><strong>${opts.currency} ${opts.amount.toFixed(2)}</strong></div>
        <div class="detail-row"><span>Payment Method</span><span>${opts.paymentMethod}</span></div>
        <div class="detail-row"><span>Transaction ID</span><span>${opts.transactionId}</span></div>
        <div class="detail-row"><span>Booking ID</span><span>${opts.bookingId}</span></div>
        <div class="detail-row"><span>Date</span><span>${new Date().toLocaleDateString()}</span></div>
      </div>
      <a class="cta" href="https://justpark.com/bookings/${opts.bookingId}">View Booking</a>
    `),
  };
}

export function refundNotificationTemplate(opts: {
  firstName:    string;
  bookingId:    string;
  refundAmount: number;
  currency:     string;
  refundedTo:   string;
}): Omit<EmailPayload, 'to'> {
  return {
    subject: `Refund Processed — ${opts.currency} ${opts.refundAmount.toFixed(2)}`,
    html: baseTemplate(`
      <p>Hi ${opts.firstName},</p>
      <p>Your refund of <strong>${opts.currency} ${opts.refundAmount.toFixed(2)}</strong> has been processed.</p>
      <div class="detail-box">
        <div class="detail-row"><span>Refund Amount</span><strong>${opts.currency} ${opts.refundAmount.toFixed(2)}</strong></div>
        <div class="detail-row"><span>Refunded To</span><span>${opts.refundedTo}</span></div>
        <div class="detail-row"><span>Booking ID</span><span>${opts.bookingId}</span></div>
      </div>
      <p>If you paid by card, please allow 5–10 business days for the refund to appear.</p>
    `),
  };
}

export function bookingReminderTemplate(opts: {
  firstName:  string;
  bookingId:  string;
  spaceName:  string;
  address:    string;
  startTime:  string;
  minutesUntilStart: number;
}): Omit<EmailPayload, 'to'> {
  const timeLabel = opts.minutesUntilStart <= 30 ? '30 minutes' : '1 hour';
  return {
    subject: `Reminder: Your parking starts in ${timeLabel}`,
    html: baseTemplate(`
      <p>Hi ${opts.firstName},</p>
      <p>Your parking booking at <strong>${opts.spaceName}</strong> starts in <strong>${timeLabel}</strong>.</p>
      <div class="detail-box">
        <div class="detail-row"><span>Location</span><span>${opts.address}</span></div>
        <div class="detail-row"><span>Start Time</span><strong>${opts.startTime}</strong></div>
      </div>
      <a class="cta" href="https://justpark.com/bookings/${opts.bookingId}">View Booking</a>
    `),
  };
}

export function supportTicketNotificationTemplate(opts: {
  ticketId: string;
  category: string;
  subject: string;
  description: string;
  bookingId?: string | null;
  requesterId?: string | null;
  requesterName: string;
  requesterEmail: string;
  requesterRole: string;
  submittedAt: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
}): Omit<EmailPayload, 'to' | 'replyTo'> {
  const attachmentBlock = opts.attachmentUrl
    ? `<div class="detail-row"><span>Attachment</span><span><a href="${escapeHtml(opts.attachmentUrl)}">${escapeHtml(opts.attachmentName ?? 'View attachment')}</a></span></div>`
    : '';

  const bookingBlock = opts.bookingId
    ? `<div class="detail-row"><span>Booking ID</span><span>${escapeHtml(opts.bookingId)}</span></div>`
    : '';

  return {
    subject: `New support ticket - ${opts.subject}`,
    html: baseTemplate(`
      <p>A new support ticket has been created in JustPark.</p>
      <div class="detail-box">
        <div class="detail-row"><span>Ticket ID</span><strong>${escapeHtml(opts.ticketId)}</strong></div>
        <div class="detail-row"><span>Category</span><span>${escapeHtml(opts.category)}</span></div>
        <div class="detail-row"><span>Subject</span><span>${escapeHtml(opts.subject)}</span></div>
        <div class="detail-row"><span>User</span><span>${escapeHtml(opts.requesterName)} (${escapeHtml(opts.requesterRole)})</span></div>
        <div class="detail-row"><span>Email</span><span>${escapeHtml(opts.requesterEmail)}</span></div>
        <div class="detail-row"><span>User ID</span><span>${escapeHtml(opts.requesterId ?? 'N/A')}</span></div>
        <div class="detail-row"><span>Submitted At</span><span>${escapeHtml(opts.submittedAt)}</span></div>
        ${bookingBlock}
        ${attachmentBlock}
      </div>
      <p><strong>Message</strong></p>
      <p>${escapeHtml(opts.description).replace(/\n/g, '<br />')}</p>
    `),
    text: [
      'A new support ticket has been created in JustPark.',
      `Ticket ID: ${opts.ticketId}`,
      `Category: ${opts.category}`,
      `Subject: ${opts.subject}`,
      `User: ${opts.requesterName} (${opts.requesterRole})`,
      `Email: ${opts.requesterEmail}`,
      `User ID: ${opts.requesterId ?? 'N/A'}`,
      `Submitted At: ${opts.submittedAt}`,
      opts.bookingId ? `Booking ID: ${opts.bookingId}` : null,
      opts.attachmentUrl ? `Attachment: ${opts.attachmentUrl}` : null,
      '',
      opts.description,
    ].filter(Boolean).join('\n'),
  };
}

export function supportTicketAcknowledgementTemplate(opts: {
  ticketId: string;
  subject: string;
  supportEmail: string;
}): Omit<EmailPayload, 'to' | 'replyTo'> {
  return {
    subject: `Support Request Received - Ticket #${opts.ticketId}`,
    html: baseTemplate(`
      <p>Thank you for contacting JustPark support.</p>
      <div class="detail-box">
        <div class="detail-row"><span>Ticket ID</span><strong>${escapeHtml(opts.ticketId)}</strong></div>
        <div class="detail-row"><span>Subject</span><span>${escapeHtml(opts.subject)}</span></div>
        <div class="detail-row"><span>Support Email</span><span>${escapeHtml(opts.supportEmail)}</span></div>
      </div>
      <p>Your request has been received successfully, and our support team will respond as soon as possible.</p>
    `),
    text: [
      'Thank you for contacting JustPark support.',
      `Ticket ID: ${opts.ticketId}`,
      `Subject: ${opts.subject}`,
      `Support Email: ${opts.supportEmail}`,
      'Your request has been received successfully, and our support team will respond as soon as possible.',
    ].join('\n'),
  };
}

export function hostNewBookingTemplate(opts: {
  host: any;
  booking: any;
  space: any;
  user: any;
}): Omit<EmailPayload, 'to'> {
  return {
    subject: `New Booking — ${opts.space.name}`,
    html: baseTemplate(`
      <p>Hi ${escapeHtml(opts.host.first_name)},</p>
      <p><strong>${escapeHtml(opts.user.first_name)}</strong> has booked your space <strong>${escapeHtml(opts.space.name)}</strong>.</p>
      <div class="detail-box">
        <div class="detail-row"><span>Check-in</span><span>${escapeHtml(new Date(opts.booking.start_time).toLocaleString())}</span></div>
        <div class="detail-row"><span>Check-out</span><span>${escapeHtml(new Date(opts.booking.end_time).toLocaleString())}</span></div>
        <div class="detail-row"><span>Vehicle Plate</span><span>${escapeHtml(opts.booking.vehicle_plate)}</span></div>
        <div class="detail-row"><span>You will receive</span><strong>₹${Number(opts.booking.host_earnings || 0).toFixed(2)}</strong></div>
      </div>
      <a class="cta" href="https://justpark.com/host/bookings/${escapeHtml(opts.booking.id)}">View Booking</a>
    `),
  };
}

export function userCancellationTemplate(opts: {
  user: any;
  booking: any;
  space: any;
  refund_amount: number;
}): Omit<EmailPayload, 'to'> {
  const refundText = opts.refund_amount > 0
    ? `Refund amount: <strong>₹${Number(opts.refund_amount).toFixed(2)}</strong>`
    : 'No refund applicable per cancellation policy.';

  return {
    subject: `Booking Cancelled — ${opts.space.name}`,
    html: baseTemplate(`
      <p>Hi ${escapeHtml(opts.user.first_name)},</p>
      <p>Your booking at <strong>${escapeHtml(opts.space.name)}</strong> has been cancelled.</p>
      <div class="detail-box">
        <div class="detail-row"><span>Original Check-in</span><span>${escapeHtml(new Date(opts.booking.start_time).toLocaleString())}</span></div>
      </div>
      <p>${refundText}</p>
      <a class="cta" href="https://justpark.com/user/home">Find Parking</a>
    `),
  };
}

export function hostCancellationTemplate(opts: {
  host: any;
  booking: any;
  space: any;
  user: any;
}): Omit<EmailPayload, 'to'> {
  return {
    subject: `Booking Cancelled by User — ${opts.space.name}`,
    html: baseTemplate(`
      <p>Hi ${escapeHtml(opts.host.first_name)},</p>
      <p><strong>${escapeHtml(opts.user.first_name)}</strong> has cancelled their booking at <strong>${escapeHtml(opts.space.name)}</strong>.</p>
      <div class="detail-box">
        <div class="detail-row"><span>Original Check-in</span><span>${escapeHtml(new Date(opts.booking.start_time).toLocaleString())}</span></div>
      </div>
      <a class="cta" href="https://justpark.com/host/my-space">View My Space</a>
    `),
  };
}
