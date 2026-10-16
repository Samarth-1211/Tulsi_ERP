import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VerificationTokenType } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * AUTO_VERIFY_NEW_USERS=true (testing, no SMTP yet): new accounts and orgs are
   * created already verified so they can log in at once. The invite email is
   * still attempted either way.
   */
  get autoVerifyNewUsers(): boolean {
    return this.configService.get<string>('AUTO_VERIFY_NEW_USERS', 'false') === 'true';
  }

  /** Frontend link for an emailed verification token (last CORS_ORIGINS entry is the frontend). */
  buildVerifyUrl(token: string): string {
    const origins = (this.configService.get<string>('CORS_ORIGINS') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const frontendUrl = origins[origins.length - 1] ?? '';
    return `${frontendUrl.replace(/\/$/, '')}/verify-email?token=${token}`;
  }

  /** Verification fields for a newly created user or organization. */
  initialVerification(): { isVerified: boolean; verifiedAt: Date | null } {
    return this.autoVerifyNewUsers
      ? { isVerified: true, verifiedAt: new Date() }
      : { isVerified: false, verifiedAt: null };
  }

  /**
   * Invalidates every outstanding (unconsumed) token for the user, of any type, then issues a fresh 24h token.
   * Revoking across types matters after an email change: a link sent to the old address must stop working.
   */
  async issueToken(userId: string, type: VerificationTokenType, orgId?: string): Promise<string> {
    await this.prisma.verificationToken.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const rawToken = crypto.randomBytes(32).toString('hex');

    await this.prisma.verificationToken.create({
      data: {
        type,
        tokenHash: hash(rawToken),
        userId,
        orgId,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });

    return rawToken;
  }

  async consumeToken(rawToken: string): Promise<{ userId: string; type: VerificationTokenType; orgId: string | null }> {
    const record = await this.prisma.verificationToken.findUnique({ where: { tokenHash: hash(rawToken) } });

    if (!record || record.consumedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('This verification link is invalid or has expired. Please request a new one.');
    }

    await this.prisma.verificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

    return { userId: record.userId, type: record.type, orgId: record.orgId };
  }

  /** Invalidates any outstanding OTP for the user, then issues a fresh 6-digit code valid for 10 minutes. */
  async issueOtp(userId: string): Promise<string> {
    await this.prisma.passwordResetOtp.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const otp = crypto.randomInt(100000, 999999).toString();

    await this.prisma.passwordResetOtp.create({
      data: {
        userId,
        otpHash: hash(otp),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    return otp;
  }

  /** Verifies the OTP against the user's most recent unconsumed one, enforcing an attempt limit. Consumes it on success. */
  async verifyOtp(userId: string, otp: string): Promise<void> {
    const record = await this.prisma.passwordResetOtp.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!record || record.expiresAt < new Date()) {
      throw new BadRequestException('This OTP is invalid or has expired. Please request a new one.');
    }

    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestException('Too many incorrect attempts. Please request a new OTP.');
    }

    if (record.otpHash !== hash(otp)) {
      await this.prisma.passwordResetOtp.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Incorrect OTP.');
    }

    await this.prisma.passwordResetOtp.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
  }
}
