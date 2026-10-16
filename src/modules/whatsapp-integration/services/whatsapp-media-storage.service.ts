import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream, ReadStream } from 'fs';
import { mkdir, stat, unlink, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';

// WhatsApp's own caps: 100 MB for documents, 16 MB for audio/video, 5 MB images.
export const MAX_WHATSAPP_MEDIA_BYTES = 100 * 1024 * 1024;

// What a CRM user may attach from the chat. WhatsApp takes JPEG/PNG images
// up to 5 MB; a PDF goes as a document (WhatsApp's own cap is 100 MB).
export const MAX_OUTBOUND_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_OUTBOUND_DOCUMENT_BYTES = 50 * 1024 * 1024;

export interface OutboundMediaType {
  messageType: 'image' | 'document';
  mimeType: string;
  ext: string;
}

// Recognised by the file's first bytes, not its name or the browser-reported type.
const OUTBOUND_TYPES: (OutboundMediaType & { matches: (b: Buffer) => boolean })[] = [
  // The PDF header may sit anywhere in the first 1 KB.
  { messageType: 'document', mimeType: 'application/pdf', ext: '.pdf', matches: (b) => b.subarray(0, 1024).includes('%PDF-') },
  { messageType: 'image', mimeType: 'image/jpeg', ext: '.jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    messageType: 'image',
    mimeType: 'image/png',
    ext: '.png',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
];

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'application/pdf': '.pdf',
};

/**
 * WhatsApp media on the backend's local disk under UPLOADS_DIR/whatsapp-media
 * — the same volume as brochures and lead sheets: inbound files (images,
 * voice notes, documents…) copied out of Meta, and the images and PDFs CRM
 * users send from the chat. Files are named by a random key;
 * the WhatsAppMessage row holds the key, original name and type.
 */
@Injectable()
export class WhatsAppMediaStorageService {
  private readonly logger = new Logger(WhatsAppMediaStorageService.name);
  private readonly dir: string;

  constructor(config: ConfigService) {
    this.dir = resolve(config.get<string>('UPLOADS_DIR') || join(process.cwd(), 'uploads'), 'whatsapp-media');
  }

  /** Streams a download to disk and returns its storage key and size. */
  async save(body: ReadableStream<Uint8Array>, mimeType: string | undefined): Promise<{ key: string; size: number }> {
    const ext = EXTENSIONS[(mimeType ?? '').split(';')[0].trim()] ?? '';
    const key = `${randomUUID()}${ext}`;
    const path = join(this.dir, key);

    await mkdir(this.dir, { recursive: true });
    await pipeline(Readable.fromWeb(body as unknown as WebReadableStream), createWriteStream(path));

    const { size } = await stat(path);
    if (size > MAX_WHATSAPP_MEDIA_BYTES) {
      await unlink(path).catch(() => undefined);
      throw new Error(`Media is larger than ${MAX_WHATSAPP_MEDIA_BYTES / 1024 / 1024} MB`);
    }
    return { key, size };
  }

  /** The kind of attachment a chat upload is, or null when it isn't one we send. */
  detectOutboundType(buffer: Buffer): OutboundMediaType | null {
    const type = OUTBOUND_TYPES.find((t) => t.matches(buffer));
    return type ? { messageType: type.messageType, mimeType: type.mimeType, ext: type.ext } : null;
  }

  /** Writes a file sent from the chat and returns its storage key. */
  async saveOutbound(buffer: Buffer, type: OutboundMediaType): Promise<string> {
    const key = `${randomUUID()}${type.ext}`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, key), buffer);
    return key;
  }

  /** The stored file, or null when it's missing from disk. */
  async open(key: string): Promise<{ stream: ReadStream; size: number } | null> {
    // Keys are generated here (uuid + ext) — reject anything else so a
    // tampered row can't point outside the media folder.
    if (!/^[0-9a-f-]{36}(\.[a-z0-9]+)?$/i.test(key)) return null;
    const path = join(this.dir, key);
    const info = await stat(path).catch(() => null);
    return info?.isFile() ? { stream: createReadStream(path), size: info.size } : null;
  }

  /** Best-effort: a file already gone is fine, anything else is logged, not thrown. */
  async delete(key: string): Promise<void> {
    if (!/^[0-9a-f-]{36}(\.[a-z0-9]+)?$/i.test(key)) return;
    try {
      await unlink(join(this.dir, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not delete WhatsApp media file ${key}: ${error}`);
      }
    }
  }
}
