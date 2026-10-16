import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly subcode?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
  }
}

interface MetaErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
  };
}

/** Graph response exactly as Meta returned it — for the debug console, which shows bodies verbatim. */
export interface MetaRawResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export const DEFAULT_GRAPH_API_VERSION = 'v25.0';

/**
 * Thin wrapper around Meta's WhatsApp Cloud API (Graph API). Every call uses
 * the organization's own System User access token — nothing here is
 * app-level except the API version, which is shared.
 */
@Injectable()
export class MetaWhatsAppClientService {
  constructor(private readonly config: ConfigService) {}

  get apiVersion(): string {
    return this.config.get<string>('META_GRAPH_API_VERSION') || DEFAULT_GRAPH_API_VERSION;
  }

  get baseUrl(): string {
    return `https://graph.facebook.com/${this.apiVersion}`;
  }

  /** Never throws on a Graph error — returns status + body as-is. Network failures still throw. */
  async requestRaw(path: string, accessToken: string, init: RequestInit = {}): Promise<MetaRawResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  private async request<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
    const { ok, status, body } = await this.requestRaw(path, accessToken, init);

    if (!ok) {
      const err = (body as MetaErrorBody).error;
      throw new MetaApiError(
        err?.error_data?.details || err?.message || `Meta API request failed with status ${status}`,
        err?.code,
        err?.error_subcode,
        status,
      );
    }

    return body as T;
  }

  /** Confirms the access token can read this phone number — the core "are these credentials real" check. */
  async fetchPhoneNumberDetails(
    phoneNumberId: string,
    accessToken: string,
  ): Promise<{ id: string; display_phone_number?: string; verified_name?: string }> {
    return this.request(
      `/${phoneNumberId}?fields=id,display_phone_number,verified_name`,
      accessToken,
    );
  }

  /** Confirms the token can also see the parent WABA (catches a phone number ID copied from a different account). */
  async fetchWabaDetails(wabaId: string, accessToken: string): Promise<{ id: string; name?: string }> {
    return this.request(`/${wabaId}?fields=id,name`, accessToken);
  }

  textMessageBody(to: string, body: string) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    };
  }

  templateMessageBody(to: string, templateName: string, languageCode: string) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: templateName, language: { code: languageCode } },
    };
  }

  async sendTextMessage(
    phoneNumberId: string,
    accessToken: string,
    to: string,
    body: string,
  ): Promise<{ messages: { id: string }[] }> {
    return this.request(`/${phoneNumberId}/messages`, accessToken, {
      method: 'POST',
      body: JSON.stringify(this.textMessageBody(to, body)),
    });
  }

  /** Template sends are the only thing WhatsApp allows outside the 24-hour customer service window. */
  async sendTemplateMessage(
    phoneNumberId: string,
    accessToken: string,
    to: string,
    templateName: string,
    languageCode: string,
  ): Promise<{ messages: { id: string }[] }> {
    return this.request(`/${phoneNumberId}/messages`, accessToken, {
      method: 'POST',
      body: JSON.stringify(this.templateMessageBody(to, templateName, languageCode)),
    });
  }

  async listApprovedTemplates(
    wabaId: string,
    accessToken: string,
  ): Promise<{ data: { name: string; language: string; category?: string; components?: unknown[] }[] }> {
    return this.request(
      `/${wabaId}/message_templates?status=APPROVED&fields=name,language,category,components&limit=100`,
      accessToken,
    );
  }

  /**
   * Step 1 of sending an attachment: hands the file to Meta, which returns a
   * media id to put in the message. Multipart, so it can't go through
   * request() — that always sends JSON.
   */
  async uploadMedia(
    phoneNumberId: string,
    accessToken: string,
    file: { buffer: Buffer; mimeType: string; fileName: string },
  ): Promise<{ id: string }> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', file.mimeType);
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.fileName);

    const res = await fetch(`${this.baseUrl}/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    const body = (await res.json().catch(() => ({}))) as MetaErrorBody & { id?: string };
    if (!res.ok || !body.id) {
      const err = body.error;
      throw new MetaApiError(
        err?.error_data?.details || err?.message || `Media upload failed with status ${res.status}`,
        err?.code,
        err?.error_subcode,
        res.status,
      );
    }
    return { id: body.id };
  }

  /** Step 2: the message that carries an uploaded image or document, with an optional caption. */
  async sendMediaMessage(
    phoneNumberId: string,
    accessToken: string,
    to: string,
    media: { type: 'image' | 'document'; mediaId: string; caption?: string; fileName?: string },
  ): Promise<{ messages: { id: string }[] }> {
    const content = {
      id: media.mediaId,
      ...(media.caption ? { caption: media.caption } : {}),
      // Only documents carry a file name — it's what the recipient sees.
      ...(media.type === 'document' && media.fileName ? { filename: media.fileName } : {}),
    };
    return this.request(`/${phoneNumberId}/messages`, accessToken, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: media.type,
        [media.type]: content,
      }),
    });
  }

  /** Step 1 of a media download: Meta's short-lived (≈5 min) URL for a media id. */
  async fetchMediaInfo(
    mediaId: string,
    accessToken: string,
  ): Promise<{ url: string; mime_type?: string; file_size?: number }> {
    return this.request(`/${mediaId}`, accessToken);
  }

  /** Step 2: the file itself — the media URL also needs the Bearer token. */
  async downloadMedia(url: string, accessToken: string): Promise<Response> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok || !res.body) {
      throw new MetaApiError(`Media download failed with status ${res.status}`, undefined, undefined, res.status);
    }
    return res;
  }
}
