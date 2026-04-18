import { Request } from 'express';

// ─────────────────────────────────────────────
// Authenticated Request (after JWT middleware)
// ─────────────────────────────────────────────
export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

// ─────────────────────────────────────────────
// JWT
// ─────────────────────────────────────────────
export interface JwtPayload {
  sub: string;       // user ID (UUID)
  email: string;
  role: UserRole;
  sessionId?: string;
  iat?: number;
  exp?: number;
  jti?: string;      // unique token ID (for blacklisting)
}

export interface RefreshTokenPayload {
  sub: string;
  sessionId: string;
  iat?: number;
  exp?: number;
}

// ─────────────────────────────────────────────
// Domain Enums (mirror Prisma enums for use without DB import)
// ─────────────────────────────────────────────
export type UserRole = 'user' | 'host' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'deactivated';
export type OtpType = 'email_verify' | 'phone_verify' | 'password_reset';
export type SocialProvider = 'google' | 'apple';
export type KycDocumentType = 'id_card' | 'passport' | 'driving_license' | 'business_registration';
export type KycStatus = 'pending' | 'approved' | 'rejected';
export type VehicleType = 'car' | 'bike' | 'ev' | 'truck' | 'van';
export type SpaceType = 'open_air' | 'covered' | 'garage' | 'indoor' | 'underground';
export type SpaceStatus = 'draft' | 'pending_review' | 'active' | 'paused' | 'rejected' | 'deleted';
export type CancellationPolicy = 'flexible' | 'moderate' | 'strict';
export type Amenity =
  | 'cctv'
  | 'ev_charging'
  | '24x7_access'
  | 'gated'
  | 'covered'
  | 'security_guard'
  | 'lighting'
  | 'wheelchair_accessible'
  | 'ev_type1'
  | 'ev_type2'
  | 'ev_ccs'
  | 'ev_chademo';
export type RateType = 'hourly' | 'daily' | 'monthly';
export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'disputed';
export type CancelledBy = 'user' | 'host' | 'admin';
export type PaymentMethod = 'card' | 'upi' | 'net_banking' | 'wallet' | 'wallet_card_split';
export type TransactionStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'partially_refunded';
export type PaymentGateway = 'stripe' | 'razorpay';
export type RefundStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type RefundTo = 'original_method' | 'wallet';
export type WalletTransactionType =
  | 'top_up'
  | 'payment'
  | 'refund'
  | 'cashback'
  | 'admin_credit'
  | 'admin_debit'
  | 'withdrawal';
export type ReviewStatus = 'active' | 'flagged' | 'removed';
export type DiscountType = 'percentage' | 'flat';
export type EarningStatus = 'pending' | 'available' | 'paid_out' | 'on_hold';
export type PayoutStatus = 'requested' | 'processing' | 'completed' | 'failed';
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type ResolutionType = 'refund' | 'partial_refund' | 'no_action' | 'credit';

// ─────────────────────────────────────────────
// API Response Types
// ─────────────────────────────────────────────
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
  meta?: PaginationMeta;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

// ─────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  hasPrev: boolean;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
}

export interface PaginationParams {
  skip: number;
  take: number;
  page: number;
  limit: number;
}

// ─────────────────────────────────────────────
// Geo / Location
// ─────────────────────────────────────────────
export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeoSearchParams {
  lat: number;
  lng: number;
  radius?: number;       // meters, default 2000, max 10000
  type?: SpaceType;
  vehicle_type?: VehicleType;
  amenities?: Amenity[];
  min_price?: number;
  max_price?: number;
  available_from?: string; // ISO date-time
  available_to?: string;   // ISO date-time
  sort?: 'distance' | 'price_asc' | 'price_desc' | 'rating';
  page?: number;
  limit?: number;
}

// ─────────────────────────────────────────────
// Pricing Engine
// ─────────────────────────────────────────────
export interface PricingBreakdownItem {
  label: string;
  amount: number;
  type: 'base' | 'multiplier' | 'discount' | 'fee' | 'tax';
}

export interface PricingCalculationResult {
  base_price: number;
  platform_fee: number;
  tax_amount: number;
  discount_amount: number;
  total_price: number;
  currency: string;
  breakdown: PricingBreakdownItem[];
}

// ─────────────────────────────────────────────
// Availability Engine
// ─────────────────────────────────────────────
export interface AvailableSlot {
  id: string;
  slot_number: string;
}

export interface AvailabilityCheckResult {
  available: boolean;
  /** Slots that are free for the requested window. Empty when space has no slots configured. */
  availableSlots: AvailableSlot[];
  conflicts: AvailabilityConflict[];
  reason?: string;
}

export interface AvailabilityConflict {
  type: 'booking' | 'blackout' | 'schedule' | 'lock' | 'duration' | 'capacity';
  message: string;
}

// ─────────────────────────────────────────────
// Slot Lock (Redis)
// ─────────────────────────────────────────────
export interface SlotLockData {
  userId: string;
  lockedAt: string;
  expiresAt: string;
}

// ─────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────
export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  uptime: number;
  version: string;
  services: {
    database: ServiceHealth;
    redis: ServiceHealth;
  };
}

export interface ServiceHealth {
  status: 'ok' | 'down';
  latency_ms?: number;
  error?: string;
}

// ─────────────────────────────────────────────
// Notification Events
// ─────────────────────────────────────────────
export type NotificationEventType =
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'booking_reminder'
  | 'booking_extension_reminder'
  | 'booking_expiry_warning'
  | 'booking_completed'
  | 'booking_no_show'
  | 'payment_success'
  | 'payment_failed'
  | 'refund_processed'
  | 'payout_processed'
  | 'kyc_approved'
  | 'kyc_rejected'
  | 'new_review'
  | 'space_approved'
  | 'space_rejected'
  | 'booking_extended'
  | 'dispute_opened'
  | 'dispute_resolved'
  | 'system_broadcast';

// ─────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────
export const ErrorCode = {
  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  INVALID_OTP: 'INVALID_OTP',
  OTP_EXPIRED: 'OTP_EXPIRED',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',

  // Resources
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',

  // Booking
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  SLOT_LOCKED: 'SLOT_LOCKED',
  BOOKING_CONFLICT: 'BOOKING_CONFLICT',
  INVALID_BOOKING_STATE: 'INVALID_BOOKING_STATE',
  BOOKING_NOT_MODIFIABLE: 'BOOKING_NOT_MODIFIABLE',
  LOCK_EXPIRED: 'LOCK_EXPIRED',
  LOCK_NOT_FOUND: 'LOCK_NOT_FOUND',

  // Payment
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_ALREADY_PROCESSED: 'PAYMENT_ALREADY_PROCESSED',
  INSUFFICIENT_WALLET_BALANCE: 'INSUFFICIENT_WALLET_BALANCE',
  INVALID_PROMO_CODE: 'INVALID_PROMO_CODE',
  PROMO_CODE_EXPIRED: 'PROMO_CODE_EXPIRED',

  // Space
  SPACE_NOT_ACTIVE: 'SPACE_NOT_ACTIVE',
  SPACE_HAS_ACTIVE_BOOKINGS: 'SPACE_HAS_ACTIVE_BOOKINGS',

  // Host
  KYC_REQUIRED: 'KYC_REQUIRED',
  KYC_PENDING: 'KYC_PENDING',

  // Server
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
