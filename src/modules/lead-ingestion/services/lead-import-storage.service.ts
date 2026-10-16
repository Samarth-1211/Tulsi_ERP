import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { createReadStream, ReadStream } from 'fs';
import { mkdir, stat, unlink, writeFile } from 'fs/promises';
import { join, resolve } from 'path';

export const SHEET_MIME_TYPES: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
};

/**
 * Uploaded lead sheets, kept exactly as uploaded so an Admin can download
 * them later — on the backend's local disk under UPLOADS_DIR/lead-imports
 * (the same volume as project brochures). Files are named by a random key;
 * the LeadImportBatch row holds the key and the original file name.
 */
@Injectable()
export class LeadImportStorageService {
  private readonly logger = new Logger(LeadImportStorageService.name);
  private readonly dir: string;

  constructor(config: ConfigService) {
    this.dir = resolve(config.get<string>('UPLOADS_DIR') || join(process.cwd(), 'uploads'), 'lead-imports');
  }

  /** Writes the file and returns its storage key. `ext` is the checked extension (.xlsx / .csv). */
  async save(buffer: Buffer, ext: string): Promise<string> {
    const key = `${randomUUID()}${ext}`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, key), buffer);
    return key;
  }

  /** Best-effort: a file already gone is fine, anything else is logged, not thrown. */
  async delete(key: string): Promise<void> {
    try {
      await unlink(join(this.dir, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not delete lead sheet file ${key}: ${error}`);
      }
    }
  }

  /** The stored file, or null when it's missing from disk. */
  async open(key: string): Promise<{ stream: ReadStream; size: number } | null> {
    const path = join(this.dir, key);
    const info = await stat(path).catch(() => null);
    return info?.isFile() ? { stream: createReadStream(path), size: info.size } : null;
  }
}
