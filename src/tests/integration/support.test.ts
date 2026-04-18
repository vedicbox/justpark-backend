import request from 'supertest';
import {
  getTestApp,
  createTestUser,
  loginTestUser,
  cleanupTestUser,
  prismaTest,
  disconnectTestPrisma,
} from '../helpers';
import { uploadImage } from '../../services/fileUpload';
import { sendSupportEmailWithResult } from '../../services/emailService';

jest.mock('../../services/fileUpload', () => {
  const actual = jest.requireActual('../../services/fileUpload');
  return {
    ...actual,
    uploadImage: jest.fn().mockResolvedValue({
      url: 'https://files.justpark-test.com/support/default.png',
      key: 'support/default.png',
    }),
  };
});

jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  return {
    ...actual,
    sendEmail: jest.fn().mockResolvedValue(undefined),
    sendSupportEmailWithResult: jest.fn().mockResolvedValue({
      status: 'sent',
      provider: 'hostinger_smtp',
    }),
  };
});

jest.mock('../../jobs/index', () => ({
  notificationQueue: { add: jest.fn().mockResolvedValue(undefined) },
  bookingQueue:      { add: jest.fn().mockResolvedValue(undefined) },
  payoutQueue:       { add: jest.fn().mockResolvedValue(undefined) },
  maintenanceQueue:  { add: jest.fn().mockResolvedValue(undefined) },
  reportsQueue:      { add: jest.fn().mockResolvedValue(undefined) },
  fraudQueue:        { add: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../../socket/handlers', () => ({
  emitSpaceAvailabilityUpdate: jest.fn(),
  emitBookingStatusChange:     jest.fn(),
  emitNewNotification:         jest.fn(),
  emitPayoutUpdate:            jest.fn(),
}));

jest.mock('../../config/firebaseAdmin', () => ({
  verifyFirebaseIdToken: jest.fn().mockResolvedValue({
    uid: 'firebase-test-user',
    phone_number: '+919999888877',
  }),
  getFirebaseAdminApp: jest.fn(),
}));

const mockedUploadImage = uploadImage as jest.MockedFunction<typeof uploadImage>;
const mockedSendSupportEmailWithResult = sendSupportEmailWithResult as jest.MockedFunction<typeof sendSupportEmailWithResult>;

describe('Support tickets', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;
  const createdUserIds: string[] = [];
  const createdTicketIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
    await prismaTest.platformConfig.upsert({
      where: { key: 'support_email' },
      update: { value: 'ops@justpark-test.com' as any },
      create: { key: 'support_email', value: 'ops@justpark-test.com' as any },
    });
  });

  beforeEach(() => {
    mockedUploadImage.mockClear();
    mockedSendSupportEmailWithResult.mockClear();
    mockedUploadImage.mockResolvedValue({
      url: 'https://files.justpark-test.com/support/default.png',
      key: 'support/default.png',
    });
    mockedSendSupportEmailWithResult.mockResolvedValue({
      status: 'sent',
      provider: 'hostinger_smtp',
    });
  });

  afterAll(async () => {
    if (createdTicketIds.length > 0) {
      await prismaTest.auditLog.deleteMany({
        where: {
          entity_type: 'support_ticket',
          entity_id: { in: createdTicketIds },
        },
      });
      await prismaTest.supportTicket.deleteMany({
        where: { id: { in: createdTicketIds } },
      });
    }

    await prismaTest.platformConfig.deleteMany({
      where: { key: 'support_email' },
    });

    for (const userId of createdUserIds) {
      await cleanupTestUser(userId);
    }

    await disconnectTestPrisma();
  });

  it('creates a ticket for a user and returns support recipient plus delivery status', async () => {
    const user = await createTestUser({ role: 'user' });
    createdUserIds.push(user.id);
    const tokens = await loginTestUser(app, user);

    const res = await request(app)
      .post('/api/v1/support/tickets')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .send({
        category: 'payment',
        subject: 'Refund still pending',
        description: 'I cancelled my booking three days ago and still have not received the refund.',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.support_email).toBe('ops@justpark-test.com');
    expect(res.body.data.email_delivery_status).toBe('sent');
    expect(res.body.data.acknowledgement_email_status).toBe('sent');
    expect(res.body.data.attachment).toBeNull();

    const ticketId = res.body.data.id as string;
    createdTicketIds.push(ticketId);

    const ticket = await prismaTest.supportTicket.findUnique({
      where: { id: ticketId },
    });
    expect(ticket).not.toBeNull();
    expect(ticket?.subject).toBe('Refund still pending');

    const notificationLog = await prismaTest.auditLog.findFirst({
      where: {
        entity_type: 'support_ticket',
        entity_id: ticketId,
        action: 'ticket.notification',
      },
    });
    expect(notificationLog).not.toBeNull();
    expect(mockedSendSupportEmailWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@justpark-test.com',
        replyTo: user.email,
      })
    );
    expect(mockedSendSupportEmailWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        to: user.email,
        subject: `Support Request Received - Ticket #${ticketId}`,
      })
    );
  });

  it('accepts a host attachment upload and stores attachment metadata in audit logs', async () => {
    mockedUploadImage.mockResolvedValueOnce({
      url: 'https://files.justpark-test.com/support/host-attachment.png',
      key: 'support/host-attachment.png',
    });

    const host = await createTestUser({ role: 'host' });
    createdUserIds.push(host.id);
    const tokens = await loginTestUser(app, host);

    const res = await request(app)
      .post('/api/v1/support/tickets')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .field('category', 'space')
      .field('subject', 'Listing photo keeps failing review')
      .field('description', 'My listing photo keeps getting rejected and I need help understanding what needs to change.')
      .attach('attachment', Buffer.from('fake-image-bytes'), {
        filename: 'listing-photo.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.support_email).toBe('ops@justpark-test.com');
    expect(res.body.data.email_delivery_status).toBe('sent');
    expect(res.body.data.acknowledgement_email_status).toBe('sent');
    expect(res.body.data.attachment).toEqual({
      url: 'https://files.justpark-test.com/support/host-attachment.png',
      original_name: 'listing-photo.png',
      mime_type: 'image/png',
      size: expect.any(Number),
    });

    const ticketId = res.body.data.id as string;
    createdTicketIds.push(ticketId);

    expect(mockedUploadImage).toHaveBeenCalledWith(
      expect.objectContaining({
        originalname: 'listing-photo.png',
        mimetype: 'image/png',
      }),
      `support/${host.id}`
    );
    expect(mockedSendSupportEmailWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@justpark-test.com',
        replyTo: host.email,
      })
    );
    expect(mockedSendSupportEmailWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        to: host.email,
        subject: `Support Request Received - Ticket #${ticketId}`,
      })
    );

    const createdLog = await prismaTest.auditLog.findFirst({
      where: {
        entity_type: 'support_ticket',
        entity_id: ticketId,
        action: 'ticket.created',
      },
    });
    expect(createdLog).not.toBeNull();
    expect(createdLog?.metadata).toEqual(
      expect.objectContaining({
        attachment: expect.objectContaining({
          url: 'https://files.justpark-test.com/support/host-attachment.png',
          original_name: 'listing-photo.png',
        }),
        requester_role: 'host',
      })
    );
  });
});
