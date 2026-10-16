import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Symmetric encryption for credential fields stored at rest (e.g. the
 * WhatsApp permanent access token). Backed by CREDENTIALS_ENCRYPTION_KEY —
 * a 32-byte key, provided as 64 hex chars or base64.
 *
 * Ciphertext layout: base64(iv[12] + authTag[16] + encrypted).
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('CREDENTIALS_ENCRYPTION_KEY');
    if (!raw) {
      throw new InternalServerErrorException(
        'CREDENTIALS_ENCRYPTION_KEY is not set in the environment',
      );
    }

    this.key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');

    if (this.key.length !== 32) {
      throw new InternalServerErrorException(
        'CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or base64)',
      );
    }
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  decrypt(payload: string): string {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
