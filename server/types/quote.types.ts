/**
 * Canonical quote types and status machine.
 * Single source of truth for Frontend, Backend, and Work.
 */

export const QUOTE_STATUSES = [
  'received',
  'in_review',
  'quoted',
  'closed',
  'pending',
  'waiting_feedback',
  'in_touch',
  'approved',
  'payment',
  // Desktop workflow statuses
  'accepted',
  'in_progress',
  'completed',
  'awaiting_director',
  'assigned',
  'rejected',
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'paid', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface QuoteItemInput {
  id: string;
  name: string;
  kind?: 'product' | 'service';
  qty: number;
  image?: string | null;
}

export interface CreateQuoteInput {
  customerName: string;
  company?: string;
  email: string;
  phone: string;
  notes?: string;
  items: QuoteItemInput[];
}

export interface TrackQuoteQuery {
  ref: string;
  email: string;
}

/** Allowed status transitions (from → to[]). Empty array = terminal. */
export const QUOTE_STATUS_TRANSITIONS: Record<string, QuoteStatus[]> = {
  received: ['in_review', 'in_touch', 'quoted', 'closed', 'assigned', 'accepted'],
  in_review: ['quoted', 'in_touch', 'waiting_feedback', 'closed', 'awaiting_director'],
  quoted: ['approved', 'payment', 'waiting_feedback', 'closed', 'in_touch'],
  pending: ['in_review', 'quoted', 'closed', 'assigned'],
  waiting_feedback: ['approved', 'quoted', 'closed', 'in_touch'],
  in_touch: ['quoted', 'approved', 'payment', 'closed', 'in_review'],
  approved: ['payment', 'closed'],
  payment: ['closed', 'approved'],
  closed: [],
  accepted: ['in_progress', 'completed', 'in_review', 'quoted', 'closed'],
  in_progress: ['completed', 'quoted', 'closed', 'awaiting_director'],
  completed: ['closed'],
  awaiting_director: ['in_review', 'quoted', 'in_progress', 'closed'],
  assigned: ['accepted', 'in_progress', 'in_review', 'closed'],
  rejected: ['closed', 'received'],
};

export function canTransitionQuoteStatus(from: QuoteStatus, to: QuoteStatus): boolean {
  if (from === to) return true;
  return QUOTE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
