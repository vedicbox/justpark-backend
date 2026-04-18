import { prisma } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { buildPaginationMeta } from '../../utils/pagination';
import { ErrorCode } from '../../types';
import { creditWallet } from '../../services/wallet';
import { logger } from '../../utils/logger';
import type { UploadedFile } from '../../services/fileUpload';
import { uploadImage } from '../../services/fileUpload';
import {
  sendSupportEmailWithResult,
  supportTicketAcknowledgementTemplate,
  supportTicketNotificationTemplate,
} from '../../services/emailService';
import {
  notifyBookingCancelled,
} from '../../services/notification';
import type {
  CreateTicketDto,
  ListTicketsQuery,
  AddTicketMessageDto,
  CreateDisputeDto,
  FaqQuery,
  AdminListTicketsQuery,
  AdminUpdateTicketDto,
  AdminResolveDisputeDto,
} from './validators';

// ─────────────────────────────────────────────
// SLA thresholds (hours) per priority before a ticket is flagged
// ─────────────────────────────────────────────
const SLA_HOURS: Record<string, number> = {
  urgent: 1,
  high:   4,
  medium: 24,
  low:    72,
};

// Default FAQ data — loaded if platform_config has no faq_articles key
const DEFAULT_FAQS = [
  { id: '1', category: 'booking', question: 'How do I cancel a booking?', answer: 'You can cancel a booking from the Bookings section in the app. Refund eligibility depends on the cancellation policy of the space.', order: 1 },
  { id: '2', category: 'booking', question: 'Can I extend my booking?', answer: 'Yes. Go to your active booking and tap "Extend". Additional charges apply for the extended duration.', order: 2 },
  { id: '3', category: 'payment', question: 'What payment methods are accepted?', answer: 'We accept cards (Visa, Mastercard), UPI, net banking, and JustPark Wallet.', order: 1 },
  { id: '4', category: 'payment', question: 'When will I receive my refund?', answer: 'Refunds to the original payment method take 5–7 business days. Wallet refunds are instant.', order: 2 },
  { id: '5', category: 'account', question: 'How do I verify my account?', answer: 'Go to Profile → Verify. Enter the OTP sent to your email or phone number.', order: 1 },
  { id: '6', category: 'space', question: 'How do I list my parking space?', answer: 'Switch to Host mode from the menu, then tap "Add Space". Fill in location, pricing, and availability.', order: 1 },
  { id: '7', category: 'dispute', question: 'How do I raise a dispute?', answer: 'If you have a problem with a completed booking, go to Support → Raise Dispute and fill in the details. Our team will review within 24 hours.', order: 1 },
  { id: '8', category: 'other', question: 'How do I contact support?', answer: 'Open a support ticket from the Help section. Our team typically responds within a few hours.', order: 1 },
];

const DEFAULT_SUPPORT_EMAIL = 'support@justpark.in';

// ─────────────────────────────────────────────
// GET /support/faq
// ─────────────────────────────────────────────
export async function getFaqs(query: FaqQuery) {
  const config = await prisma.platformConfig.findUnique({ where: { key: 'faq_articles' } });
  const articles: typeof DEFAULT_FAQS = config ? (config.value as unknown as typeof DEFAULT_FAQS) : DEFAULT_FAQS;

  let filtered = articles;

  if (query.category) {
    filtered = filtered.filter((a) => a.category === query.category);
  }

  if (query.q) {
    const q = query.q.toLowerCase();
    filtered = filtered.filter(
      (a) =>
        a.question.toLowerCase().includes(q) ||
        a.answer.toLowerCase().includes(q)
    );
  }

  // Group by category
  const grouped: Record<string, typeof DEFAULT_FAQS> = {};
  for (const item of filtered.sort((a, b) => a.order - b.order)) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }

  return { categories: grouped, total: filtered.length };
}

// ─────────────────────────────────────────────
// POST /support/tickets
// ─────────────────────────────────────────────
export async function createTicket(userId: string, dto: CreateTicketDto, attachment?: UploadedFile) {
  // Validate bookingId belongs to user if provided
  if (dto.booking_id) {
    const booking = await prisma.booking.findUnique({
      where:  { id: dto.booking_id },
      select: { id: true, user_id: true },
    });
    if (!booking) throw AppError.notFound('Booking');
    if (booking.user_id !== userId) throw AppError.forbidden();
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      first_name: true,
      last_name: true,
      role: true,
    },
  });
  if (!user) throw AppError.notFound('User');

  const uploadedAttachment = attachment
    ? await uploadImage(attachment, `support/${userId}`)
    : null;

  const attachmentMeta = uploadedAttachment
    ? {
        url: uploadedAttachment.url,
        original_name: attachment?.originalname ?? null,
        mime_type: attachment?.mimetype ?? null,
        size: attachment?.size ?? null,
      }
    : null;

  const ticket = await prisma.supportTicket.create({
    data: {
      user_id:     userId,
      booking_id:  dto.booking_id ?? null,
      category:    dto.category,
      subject:     dto.subject,
      description: dto.description,
      status:      'open',
      priority:    dto.category === 'dispute' ? 'high' : 'medium',
    },
    select: {
      id:          true,
      category:    true,
      subject:     true,
      description: true,
      status:      true,
      priority:    true,
      booking_id:  true,
      created_at:  true,
    },
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    userId,
      action:      'ticket.created',
      entity_type: 'support_ticket',
      entity_id:   ticket.id,
      metadata:    {
        source: 'help_center',
        requester_role: user.role,
        attachment: attachmentMeta,
      } as any,
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  const supportEmail = await getSupportRecipientEmail();
  const supportInboxTemplate = supportTicketNotificationTemplate({
    ticketId: ticket.id,
    category: ticket.category,
    subject: ticket.subject,
    description: ticket.description,
    bookingId: ticket.booking_id,
    requesterId: user.id,
    requesterName: `${user.first_name} ${user.last_name}`.trim(),
    requesterEmail: user.email,
    requesterRole: user.role,
    submittedAt: ticket.created_at.toISOString(),
    attachmentUrl: attachmentMeta?.url,
    attachmentName: attachmentMeta?.original_name,
  });
  const supportEmailResult = await sendSupportEmailWithResult({
    to: supportEmail,
    replyTo: user.email,
    ...supportInboxTemplate,
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    userId,
      action:      'ticket.notification',
      entity_type: 'support_ticket',
      entity_id:   ticket.id,
      metadata:    {
        channel: 'email',
        provider: supportEmailResult.provider,
        recipient: supportEmail,
        status: supportEmailResult.status,
        reason: supportEmailResult.reason ?? null,
      } as any,
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  const acknowledgementTemplate = supportTicketAcknowledgementTemplate({
    ticketId: ticket.id,
    subject: ticket.subject,
    supportEmail,
  });
  logger.info({
    msg: 'Sending support acknowledgement email',
    ticketId: ticket.id,
    userId,
    userEmail: user.email,
  });
  const acknowledgementEmailResult = await sendSupportEmailWithResult({
    to: user.email,
    ...acknowledgementTemplate,
  });

  await prisma.auditLog.create({
    data: {
      actor_id:    userId,
      action:      'ticket.acknowledgement',
      entity_type: 'support_ticket',
      entity_id:   ticket.id,
      metadata:    {
        channel: 'email',
        provider: acknowledgementEmailResult.provider,
        recipient: user.email,
        status: acknowledgementEmailResult.status,
        reason: acknowledgementEmailResult.reason ?? null,
        provider_message_id: acknowledgementEmailResult.providerMessageId ?? null,
      } as any,
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  logger.info({
    msg: 'Support acknowledgement email processed',
    ticketId: ticket.id,
    userId,
    userEmail: user.email,
    status: acknowledgementEmailResult.status,
    provider: acknowledgementEmailResult.provider,
    providerMessageId: acknowledgementEmailResult.providerMessageId ?? null,
    reason: acknowledgementEmailResult.reason ?? null,
  });

  logger.info({
    msg: 'Support ticket created',
    ticketId: ticket.id,
    userId,
    supportEmail,
    supportEmailStatus: supportEmailResult.status,
    acknowledgementEmailStatus: acknowledgementEmailResult.status,
    hasAttachment: Boolean(attachmentMeta),
  });

  return {
    ...ticket,
    attachment: attachmentMeta,
    support_email: supportEmail,
    email_delivery_status: supportEmailResult.status,
    ...(supportEmailResult.reason ? { email_delivery_reason: supportEmailResult.reason } : {}),
    acknowledgement_email_status: acknowledgementEmailResult.status,
    ...(acknowledgementEmailResult.reason ? { acknowledgement_email_reason: acknowledgementEmailResult.reason } : {}),
  };
}

// ─────────────────────────────────────────────
// GET /support/tickets
// ─────────────────────────────────────────────
export async function listTickets(userId: string, query: ListTicketsQuery) {
  const { status, page, limit } = query;
  const skip = (page - 1) * limit;

  const where = {
    user_id: userId,
    ...(status && { status }),
  };

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      select: {
        id:          true,
        category:    true,
        subject:     true,
        status:      true,
        priority:    true,
        booking_id:  true,
        assigned_to: true,
        created_at:  true,
        updated_at:  true,
        dispute:     { select: { id: true, resolution_type: true, resolved_at: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.supportTicket.count({ where }),
  ]);

  return { tickets, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// GET /support/tickets/:id
// ─────────────────────────────────────────────
export async function getTicket(userId: string, ticketId: string) {
  const ticket = await prisma.supportTicket.findUnique({
    where:  { id: ticketId },
    select: {
      id:          true,
      category:    true,
      subject:     true,
      description: true,
      status:      true,
      priority:    true,
      booking_id:  true,
      assigned_to: true,
      created_at:  true,
      updated_at:  true,
      dispute:     {
        select: {
          id:              true,
          reason:          true,
          resolution:      true,
          resolution_type: true,
          resolved_at:     true,
        },
      },
    },
  });

  if (!ticket) throw AppError.notFound('Ticket');
  if (ticket.assigned_to !== null) {
    // Only owner can view their ticket
  }
  // Non-admin: must be their own ticket
  const raw = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { user_id: true } });
  if (!raw || raw.user_id !== userId) throw AppError.forbidden();

  // Fetch message thread from audit_logs
  const [messages, metadata] = await Promise.all([
    getTicketMessages(ticketId),
    getTicketMetadata(ticketId),
  ]);

  return { ...ticket, ...metadata, messages };
}

// ─────────────────────────────────────────────
// POST /support/tickets/:id/messages
// ─────────────────────────────────────────────
export async function addTicketMessage(userId: string, ticketId: string, dto: AddTicketMessageDto, senderRole: string) {
  // Verify ticket exists and belongs to user (or admin can message any ticket)
  const ticket = await prisma.supportTicket.findUnique({
    where:  { id: ticketId },
    select: { id: true, user_id: true, status: true },
  });

  if (!ticket) throw AppError.notFound('Ticket');

  if (senderRole !== 'admin' && ticket.user_id !== userId) {
    throw AppError.forbidden();
  }

  if (['resolved', 'closed'].includes(ticket.status) && senderRole !== 'admin') {
    throw AppError.badRequest(ErrorCode.INVALID_BOOKING_STATE, 'Ticket is already resolved or closed');
  }

  // Store message in audit_log
  const log = await prisma.auditLog.create({
    data: {
      actor_id:    userId,
      action:      'ticket.message',
      entity_type: 'support_ticket',
      entity_id:   ticketId,
      metadata:    { message: dto.message, sender_role: senderRole } as any,
    },
    select: {
      id:         true,
      actor_id:   true,
      metadata:   true,
      created_at: true,
    },
  });

  // Update ticket updated_at
  await prisma.supportTicket.update({
    where: { id: ticketId },
    data:  { updated_at: new Date() },
  });

  return {
    id:          log.id,
    ticket_id:   ticketId,
    sender_id:   userId,
    sender_role: senderRole,
    message:     dto.message,
    created_at:  log.created_at,
  };
}

// ─────────────────────────────────────────────
// POST /support/disputes
// ─────────────────────────────────────────────
export async function createDispute(userId: string, dto: CreateDisputeDto) {
  const booking = await prisma.booking.findUnique({
    where:  { id: dto.booking_id },
    select: { id: true, user_id: true, status: true, space: { select: { name: true } } },
  });

  if (!booking) throw AppError.notFound('Booking');
  if (booking.user_id !== userId) throw AppError.forbidden();

  if (!['completed', 'cancelled'].includes(booking.status)) {
    throw AppError.badRequest(
      ErrorCode.INVALID_BOOKING_STATE,
      'Disputes can only be raised for completed or cancelled bookings'
    );
  }

  // Check no existing dispute for this booking
  const existingDispute = await prisma.dispute.findUnique({
    where:  { booking_id: dto.booking_id },
    select: { id: true },
  });
  if (existingDispute) {
    throw AppError.conflict(ErrorCode.ALREADY_EXISTS, 'A dispute already exists for this booking');
  }

  const result = await prisma.$transaction(async (tx) => {
    // Create support ticket first
    const ticket = await tx.supportTicket.create({
      data: {
        user_id:     userId,
        booking_id:  dto.booking_id,
        category:    'dispute',
        subject:     `Dispute: ${booking.space.name}`,
        description: dto.reason,
        status:      'open',
        priority:    'high',
      },
    });

    // Create dispute linked to the ticket
    const dispute = await tx.dispute.create({
      data: {
        ticket_id:  ticket.id,
        booking_id: dto.booking_id,
        raised_by:  userId,
        reason:     dto.reason,
      },
      select: {
        id:         true,
        ticket_id:  true,
        booking_id: true,
        raised_by:  true,
        reason:     true,
        created_at: true,
      },
    });

    // Put related host_earning on hold
    await tx.hostEarning.updateMany({
      where: { booking_id: dto.booking_id, status: { in: ['pending', 'available'] } },
      data:  { status: 'on_hold' },
    });

    // Update booking status to disputed
    await tx.booking.update({
      where: { id: dto.booking_id },
      data:  { status: 'disputed' },
    });

    return { ticket, dispute };
  });

  return result;
}

// ─────────────────────────────────────────────
// Admin — GET /admin/tickets
// ─────────────────────────────────────────────
export async function adminListTickets(query: AdminListTicketsQuery) {
  const { status, priority, assigned_to, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (status)      where['status']      = status;
  if (priority)    where['priority']    = priority;
  if (assigned_to) where['assigned_to'] = assigned_to;

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      select: {
        id:          true,
        category:    true,
        subject:     true,
        status:      true,
        priority:    true,
        assigned_to: true,
        booking_id:  true,
        created_at:  true,
        updated_at:  true,
        user: { select: { id: true, first_name: true, last_name: true, email: true } },
        assignee: { select: { id: true, first_name: true, last_name: true } },
        dispute: { select: { id: true, resolution_type: true, resolved_at: true } },
      },
      orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
      skip,
      take: limit,
    }),
    prisma.supportTicket.count({ where }),
  ]);

  const now = Date.now();

  const enriched = tickets.map((t) => {
    const slaHours = SLA_HOURS[t.priority] ?? 24;
    const ageHours = (now - t.created_at.getTime()) / (1000 * 60 * 60);
    const sla_breached = t.status === 'open' && !t.assigned_to && ageHours > slaHours;
    return { ...t, sla_breached, age_hours: Math.round(ageHours * 10) / 10 };
  });

  return { tickets: enriched, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// Admin — PATCH /admin/tickets/:id
// ─────────────────────────────────────────────
export async function adminUpdateTicket(adminId: string, ticketId: string, dto: AdminUpdateTicketDto) {
  const ticket = await prisma.supportTicket.findUnique({
    where:  { id: ticketId },
    select: { id: true, status: true },
  });
  if (!ticket) throw AppError.notFound('Ticket');

  const { note, ...updates } = dto;

  const updated = await prisma.supportTicket.update({
    where: { id: ticketId },
    data:  {
      ...(updates.status      !== undefined && { status:      updates.status }),
      ...(updates.priority    !== undefined && { priority:    updates.priority }),
      ...(updates.assigned_to !== undefined && { assigned_to: updates.assigned_to }),
    },
    select: {
      id:          true,
      status:      true,
      priority:    true,
      assigned_to: true,
      updated_at:  true,
    },
  });

  // Audit log — ticket metadata change (status, priority, assignment)
  prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'ticket.updated',
      entity_type: 'support_ticket',
      entity_id:   ticketId,
      metadata:    { changes: updates, previous_status: ticket.status } as any,
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  // Append admin note as message if provided
  if (note) {
    await prisma.auditLog.create({
      data: {
        actor_id:    adminId,
        action:      'ticket.message',
        entity_type: 'support_ticket',
        entity_id:   ticketId,
        metadata:    { message: note, sender_role: 'admin' } as any,
      },
    });
  }

  return updated;
}

// ─────────────────────────────────────────────
// Admin — GET /admin/disputes
// ─────────────────────────────────────────────
export async function adminListDisputes(query: { status?: string; page: number; limit: number }) {
  const { status, page, limit } = query;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (status === 'open')     where['resolved_at'] = null;
  if (status === 'resolved') where['resolved_at'] = { not: null };

  const [disputes, total] = await Promise.all([
    prisma.dispute.findMany({
      where,
      select: {
        id:              true,
        reason:          true,
        resolution:      true,
        resolution_type: true,
        resolved_at:     true,
        created_at:      true,
        raiser:   { select: { id: true, first_name: true, last_name: true, email: true } },
        resolver: { select: { id: true, first_name: true, last_name: true } },
        booking:  { select: { id: true, status: true, total_price: true } },
        ticket:   { select: { id: true, status: true, priority: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.dispute.count({ where }),
  ]);

  return { disputes, meta: buildPaginationMeta(total, page, limit) };
}

// ─────────────────────────────────────────────
// Admin — PATCH /admin/disputes/:id/resolve
// ─────────────────────────────────────────────
export async function adminResolveDispute(adminId: string, disputeId: string, dto: AdminResolveDisputeDto) {
  const dispute = await prisma.dispute.findUnique({
    where:  { id: disputeId },
    select: {
      id:          true,
      resolved_at: true,
      booking_id:  true,
      raised_by:   true,
      ticket_id:   true,
      booking: {
        select: {
          id:          true,
          total_price: true,
          user_id:     true,
          cancelled_by: true,
          cancelled_at: true,
          transactions: {
            where:  { status: { in: ['completed', 'partially_refunded'] } },
            select: { id: true, amount: true, status: true },
            take:   1,
          },
        },
      },
    },
  });

  if (!dispute) throw AppError.notFound('Dispute');
  if (dispute.resolved_at) throw AppError.conflict(ErrorCode.ALREADY_EXISTS, 'Dispute already resolved');

  const { resolution, resolution_type, refund_amount } = dto;
  const wasCancelledBeforeDispute = Boolean(dispute.booking.cancelled_at || dispute.booking.cancelled_by);

  await prisma.$transaction(async (tx) => {
    // Resolve the dispute record
    await tx.dispute.update({
      where: { id: disputeId },
      data: {
        resolution,
        resolution_type,
        resolved_by: adminId,
        resolved_at: new Date(),
      },
    });

    // Update linked ticket to resolved
    await tx.supportTicket.update({
      where: { id: dispute.ticket_id },
      data:  { status: 'resolved' },
    });

    // Handle host earnings
    if (resolution_type === 'no_action') {
      if (!wasCancelledBeforeDispute) {
        // Completed bookings return to their normal lifecycle when the dispute
        // is rejected; cancelled bookings keep their original on-hold earnings.
        await tx.hostEarning.updateMany({
          where: { booking_id: dispute.booking_id, status: 'on_hold', payout_id: null },
          data:  { status: 'available' },
        });
      }
      await tx.booking.update({
        where: { id: dispute.booking_id },
        data:  { status: wasCancelledBeforeDispute ? 'cancelled' : 'completed' },
      });
    } else {
      // For refund/partial_refund/credit: keep disputed earnings on hold so
      // they never become withdrawable again through the release job.
      await tx.booking.update({
        where: { id: dispute.booking_id },
        data:  { status: 'cancelled', cancelled_by: 'admin', cancellation_reason: `Dispute resolved: ${resolution_type}` },
      });
    }
  });

  // Handle financial resolution outside the main transaction (uses external services)
  if (['refund', 'partial_refund'].includes(resolution_type)) {
    const transaction = dispute.booking.transactions[0];
    if (transaction) {
      const { initiateRefund } = await import('../../services/refund');
      await initiateRefund({
        transactionId:  transaction.id,
        reason:         `Dispute resolved: ${resolution}`,
        initiatedBy:    adminId,
        amountOverride: resolution_type === 'partial_refund' ? refund_amount : undefined,
        refundTo:       'original_method',
      }).catch(() => {
        // Fallback to wallet credit if gateway refund fails
        const fallbackAmount = resolution_type === 'partial_refund'
          ? (refund_amount ?? Number(transaction.amount))
          : Number(transaction.amount);
        creditWallet({
          userId:        dispute.booking.user_id,
          amount:        fallbackAmount,
          type:          'refund',
          referenceType: 'dispute',
          referenceId:   disputeId,
          description:   `Dispute refund: ${resolution_type}`,
        }).catch(() => {});
      });
    }
  } else if (resolution_type === 'credit') {
    const creditAmount = refund_amount ?? Number(dispute.booking.total_price) * 0.1; // 10% default
    await creditWallet({
      userId:        dispute.booking.user_id,
      amount:        creditAmount,
      type:          'admin_credit',
      referenceType: 'dispute',
      referenceId:   disputeId,
      description:   `Dispute goodwill credit`,
    });
  }

  // Audit log — dispute resolution
  prisma.auditLog.create({
    data: {
      actor_id:    adminId,
      action:      'dispute.resolved',
      entity_type: 'dispute',
      entity_id:   disputeId,
      metadata:    { resolution_type, resolution, refund_amount } as any,
    },
  }).catch((e) => logger.error(e, 'AUDIT_LOG_WRITE_FAILED'));

  // Notify both parties
  notifyBookingCancelled(dispute.raised_by, dispute.booking_id, `Dispute resolved: ${resolution_type}`).catch(() => {});

  return {
    dispute_id:      disputeId,
    resolution_type,
    resolved_at:     new Date(),
  };
}

// ─────────────────────────────────────────────
// Internal helper — fetch ticket message thread
// ─────────────────────────────────────────────
async function getTicketMessages(ticketId: string) {
  const logs = await prisma.auditLog.findMany({
    where: {
      entity_type: 'support_ticket',
      entity_id:   ticketId,
      action:      'ticket.message',
    },
    select: {
      id:         true,
      actor_id:   true,
      metadata:   true,
      created_at: true,
      actor:      { select: { first_name: true, last_name: true, role: true } },
    },
    orderBy: { created_at: 'asc' },
  });

  return logs.map((log) => {
    const meta = log.metadata as { message: string; sender_role: string } | null;
    return {
      id:          log.id,
      sender_id:   log.actor_id,
      sender_name: log.actor ? `${log.actor.first_name} ${log.actor.last_name}` : 'System',
      sender_role: meta?.sender_role ?? log.actor?.role ?? 'user',
      message:     meta?.message ?? '',
      created_at:  log.created_at,
    };
  });
}

// ─────────────────────────────────────────────
// Admin — GET /admin/tickets/:id (with messages)
// ─────────────────────────────────────────────
export async function adminGetTicket(ticketId: string) {
  const ticket = await prisma.supportTicket.findUnique({
    where:  { id: ticketId },
    select: {
      id:          true,
      category:    true,
      subject:     true,
      description: true,
      status:      true,
      priority:    true,
      assigned_to: true,
      booking_id:  true,
      created_at:  true,
      updated_at:  true,
      user:     { select: { id: true, first_name: true, last_name: true, email: true } },
      assignee: { select: { id: true, first_name: true, last_name: true } },
      dispute:  {
        select: {
          id:              true,
          reason:          true,
          resolution:      true,
          resolution_type: true,
          resolved_at:     true,
          resolved_by:     true,
        },
      },
    },
  });

  if (!ticket) throw AppError.notFound('Ticket');

  const [messages, metadata] = await Promise.all([
    getTicketMessages(ticketId),
    getTicketMetadata(ticketId),
  ]);
  const slaHours = SLA_HOURS[ticket.priority] ?? 24;
  const ageHours = (Date.now() - ticket.created_at.getTime()) / (1000 * 60 * 60);
  const sla_breached = ticket.status === 'open' && !ticket.assigned_to && ageHours > slaHours;

  return { ...ticket, ...metadata, messages, sla_breached, age_hours: Math.round(ageHours * 10) / 10 };
}

async function getSupportRecipientEmail(): Promise<string> {
  const row = await prisma.platformConfig.findUnique({
    where: { key: 'support_email' },
    select: { value: true },
  });

  const value = row?.value;
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (
    value &&
    typeof value === 'object' &&
    'value' in value &&
    typeof (value as { value?: unknown }).value === 'string'
  ) {
    const nestedValue = (value as { value: string }).value.trim();
    if (nestedValue) return nestedValue;
  }

  return DEFAULT_SUPPORT_EMAIL;
}

async function getTicketMetadata(ticketId: string) {
  const logs = await prisma.auditLog.findMany({
    where: {
      entity_type: 'support_ticket',
      entity_id: ticketId,
      action: { in: ['ticket.created', 'ticket.notification', 'ticket.acknowledgement'] },
    },
    select: {
      action: true,
      metadata: true,
      created_at: true,
    },
    orderBy: { created_at: 'asc' },
  });

  let attachment: {
    url: string;
    original_name: string | null;
    mime_type: string | null;
    size: number | null;
  } | null = null;
  let support_email: string | null = null;
  let email_delivery_status: string | null = null;
  let email_delivery_reason: string | null = null;
  let acknowledgement_email_status: string | null = null;
  let acknowledgement_email_reason: string | null = null;

  for (const log of logs) {
    if (log.action === 'ticket.created') {
      const meta = log.metadata as {
        attachment?: {
          url?: string;
          original_name?: string | null;
          mime_type?: string | null;
          size?: number | null;
        } | null;
      } | null;

      if (meta?.attachment?.url) {
        attachment = {
          url: meta.attachment.url,
          original_name: meta.attachment.original_name ?? null,
          mime_type: meta.attachment.mime_type ?? null,
          size: meta.attachment.size ?? null,
        };
      }
    }

    if (log.action === 'ticket.notification') {
      const meta = log.metadata as {
        recipient?: string | null;
        status?: string | null;
        reason?: string | null;
      } | null;

      support_email = meta?.recipient ?? support_email;
      email_delivery_status = meta?.status ?? email_delivery_status;
      email_delivery_reason = meta?.reason ?? email_delivery_reason;
    }

    if (log.action === 'ticket.acknowledgement') {
      const meta = log.metadata as {
        status?: string | null;
        reason?: string | null;
      } | null;

      acknowledgement_email_status = meta?.status ?? acknowledgement_email_status;
      acknowledgement_email_reason = meta?.reason ?? acknowledgement_email_reason;
    }
  }

  return {
    attachment,
    support_email,
    email_delivery_status,
    email_delivery_reason,
    acknowledgement_email_status,
    acknowledgement_email_reason,
  };
}
