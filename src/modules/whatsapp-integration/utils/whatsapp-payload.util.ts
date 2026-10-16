import { WhatsAppMessageStatus } from '@prisma/client';

// Shapes of Meta's WhatsApp Cloud API webhook payload — only the fields we
// read. Reference: developers.facebook.com/docs/whatsapp/cloud-api/webhooks

export interface MetaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

// Attached to the first message someone sends after tapping a
// Click-to-WhatsApp ad (or a boosted post) — never to later messages.
export interface MetaReferral {
  source_url?: string;
  source_id?: string;
  source_type?: 'ad' | 'post' | string;
  headline?: string;
  body?: string;
  media_type?: string;
  ctwa_clid?: string;
  image_url?: string;
  video_url?: string;
  thumbnail_url?: string;
}

export interface MetaMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  referral?: MetaReferral;
  text?: { body: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title: string };
    list_reply?: { id?: string; title: string; description?: string };
    nfm_reply?: { body?: string; name?: string; response_json?: string };
  };
  image?: MetaMedia;
  document?: MetaMedia;
  audio?: MetaMedia;
  video?: MetaMedia;
  sticker?: MetaMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string; wa_id?: string }[] }[];
  reaction?: { message_id?: string; emoji?: string };
  context?: { id?: string; from?: string };
  errors?: { code?: number; title?: string }[];
}

export interface MetaStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

export interface MetaWebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

export interface MetaWebhookPayload {
  object?: string;
  entry?: { id?: string; changes?: { field: string; value: MetaWebhookValue }[] }[];
}

const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

export function isMediaType(type: string): type is MediaType {
  return (MEDIA_TYPES as readonly string[]).includes(type);
}

export interface ExtractedContent {
  messageType: string;
  textBody?: string;
  mediaId?: string;
  mediaMimeType?: string;
  mediaFileName?: string;
}

/** Turns one inbound Meta message into what we store — every type gets a readable textBody, unknown ones included. */
export function extractContent(message: MetaMessage): ExtractedContent {
  switch (message.type) {
    case 'text':
      return { messageType: 'text', textBody: message.text?.body };
    case 'button':
      return { messageType: 'text', textBody: message.button?.text ?? message.button?.payload };
    case 'interactive': {
      const i = message.interactive;
      return {
        messageType: 'text',
        textBody: i?.button_reply?.title ?? i?.list_reply?.title ?? i?.nfm_reply?.body ?? '[interactive reply]',
      };
    }
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'sticker': {
      const media = message[message.type];
      return {
        messageType: message.type,
        textBody: media?.caption || undefined,
        mediaId: media?.id,
        mediaMimeType: media?.mime_type,
        mediaFileName: media?.filename,
      };
    }
    case 'location': {
      const loc = message.location;
      const label = [loc?.name, loc?.address].filter(Boolean).join(', ');
      return {
        messageType: 'location',
        textBody: `Location shared: ${loc?.latitude}, ${loc?.longitude}${label ? ` (${label})` : ''}`,
      };
    }
    case 'contacts': {
      const cards = (message.contacts ?? []).map((c) => {
        const phones = (c.phones ?? []).map((p) => p.phone ?? p.wa_id).filter(Boolean).join(', ');
        return [c.name?.formatted_name, phones].filter(Boolean).join(' — ');
      });
      return { messageType: 'contacts', textBody: `Contact shared: ${cards.join('; ') || 'unnamed contact'}` };
    }
    case 'reaction':
      return {
        messageType: 'reaction',
        textBody: message.reaction?.emoji ? `Reacted ${message.reaction.emoji}` : 'Removed a reaction',
      };
    default: {
      const reason = message.errors?.[0]?.title;
      return {
        messageType: message.type || 'unknown',
        textBody: `[unsupported message type${message.type ? `: ${message.type}` : ''}${reason ? ` — ${reason}` : ''}]`,
      };
    }
  }
}

export interface AdReferral {
  adId: string;
  sourceType: string;
  headline: string | null;
  body: string | null;
  sourceUrl: string | null;
}

/** The ad a message came from, or null — a referral with no source id can't be told apart from any other. */
export function extractAdReferral(message: MetaMessage): AdReferral | null {
  const referral = message.referral;
  const adId = typeof referral?.source_id === 'string' ? referral.source_id.trim() : '';
  if (!referral || !adId) return null;

  return {
    adId,
    sourceType: referral.source_type?.trim() || 'ad',
    headline: referral.headline?.trim() || null,
    body: referral.body?.trim() || null,
    sourceUrl: referral.source_url?.trim() || null,
  };
}

/** One-line description of a webhook POST for the event log and the debug console filters. */
export function summarizeWebhookPayload(payload: MetaWebhookPayload): {
  object: string | null;
  phoneNumberId: string | null;
  eventType: string;
  entryCount: number;
} {
  let hasMessages = false;
  let hasStatuses = false;
  let phoneNumberId: string | null = null;

  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      phoneNumberId ??= change.value?.metadata?.phone_number_id ?? null;
      if (change.value?.messages?.length) hasMessages = true;
      if (change.value?.statuses?.length) hasStatuses = true;
    }
  }

  const eventType =
    hasMessages && hasStatuses ? 'messages+statuses' : hasMessages ? 'messages' : hasStatuses ? 'statuses' : 'other';

  return {
    object: typeof payload?.object === 'string' ? payload.object : null,
    phoneNumberId,
    eventType,
    entryCount: payload?.entry?.length ?? 0,
  };
}

/** Every inbound wamid in a payload — lets the pipeline trace find the rows an event produced. */
export function inboundMessageIds(payload: MetaWebhookPayload): string[] {
  return (payload?.entry ?? []).flatMap((e) =>
    (e.changes ?? []).flatMap((c) => (c.value?.messages ?? []).map((m) => m.id).filter(Boolean)),
  );
}

export function mapMetaStatus(raw: MetaStatus['status']): WhatsAppMessageStatus {
  switch (raw) {
    case 'delivered':
      return WhatsAppMessageStatus.DELIVERED;
    case 'read':
      return WhatsAppMessageStatus.READ;
    case 'failed':
      return WhatsAppMessageStatus.FAILED;
    default:
      return WhatsAppMessageStatus.SENT;
  }
}

const STATUS_RANK: Record<WhatsAppMessageStatus, number> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: 4,
};

/**
 * Meta doesn't guarantee status callbacks arrive in order — a "delivered"
 * landing after "read" must not move the tick backwards. FAILED always wins.
 */
export function nextMessageStatus(
  current: WhatsAppMessageStatus,
  incoming: WhatsAppMessageStatus,
): WhatsAppMessageStatus {
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : current;
}

/**
 * The CTWA referral as LeadAdAttribution fields (ad id, ctwa_clid, copy,
 * media) plus the raw referral object — null when the message has no ad
 * referral. RCRM's own WhatsAppAdSource capture is unchanged; this is the
 * normalized copy written next to it.
 */
export function referralAttribution(message: MetaMessage) {
  const referral = message.referral;
  if (!extractAdReferral(message) || !referral) return null;
  const clean = (v: string | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    platform: 'META',
    adId: clean(referral.source_id),
    sourceType: clean(referral.source_type) ?? 'ad',
    sourceUrl: clean(referral.source_url),
    headline: clean(referral.headline),
    body: clean(referral.body),
    ctwaClid: clean(referral.ctwa_clid),
    mediaType: clean(referral.media_type),
    imageUrl: clean(referral.image_url),
    videoUrl: clean(referral.video_url),
    thumbnailUrl: clean(referral.thumbnail_url),
    raw: referral as unknown as Record<string, unknown>,
  };
}
