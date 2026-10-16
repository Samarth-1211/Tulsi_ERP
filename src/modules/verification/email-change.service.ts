import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User, Role, VerificationTokenType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryStatus, MailService } from '../mail/mail.service';
import { VerificationService } from './verification.service';

@Injectable()
export class EmailChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly verificationService: VerificationService,
  ) {}

  private buildVerifyUrl(token: string): string {
    const origins = this.configService
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const frontendUrl = origins[origins.length - 1];

    if (!frontendUrl) {
      throw new InternalServerErrorException('CORS_ORIGINS is not configured');
    }

    return `${frontendUrl.replace(/\/$/, '')}/verify-email?token=${token}`;
  }

  /**
   * Switches the account to the new email, marks it unverified until the
   * owner clicks the link emailed to that address, and invalidates any link
   * sent earlier. Callers must check the address is free in the org first.
   * A failed send is reported rather than thrown, since the change is
   * already committed and can be retried via "Resend verification".
   */
  async changeEmail(userId: string, newEmail: string): Promise<{ user: User; emailDelivery: EmailDeliveryStatus }> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { email: newEmail, isVerified: false, verifiedAt: null },
      include: { org: { select: { name: true } } },
    });

    const token = await this.verificationService.issueToken(user.id, VerificationTokenType.USER_VERIFY);
    const emailDelivery = await this.mailService.attempt(() =>
      this.mailService.sendEmailChangeVerification({
        to: newEmail,
        name: user.name,
        // Super Admins have no org.
        orgName: user.role === Role.SUPER_ADMIN ? null : (user.org?.name ?? null),
        verifyUrl: this.buildVerifyUrl(token),
      }),
    );

    const { org, ...updated } = user;
    return { user: updated, emailDelivery };
  }
}
