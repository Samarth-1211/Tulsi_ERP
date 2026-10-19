import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { NotificationType, User, Role, UserStatus, VerificationTokenType } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { MailService } from '../../../mail/mail.service';
import { MailDeliveryException } from '../../../mail/mail-delivery.exception';
import { VerificationService } from '../../../verification/verification.service';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';

const SALT_ROUNDS = 12;
/** A rotated refresh token reused within this window is a multi-tab race, not theft. */
const REFRESH_REUSE_GRACE_MS = 60_000;
/** Compared against when the email matches no account, to keep login timing uniform. */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', SALT_ROUNDS);

/**
 * Reset codes only reach the user by email, so a broken mailer means the
 * password genuinely cannot be changed right now. Saying so beats the old
 * behaviour of claiming a code was sent that never left the server.
 */
function passwordResetUnavailable(reason: string): ServiceUnavailableException {
  return new ServiceUnavailableException(
    `Your password can't be changed at the moment — we couldn't email the reset code because ${reason}. ` +
      'Please try again later or contact your administrator.',
  );
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly verificationService: VerificationService,
  ) {}

  private hashOpaqueToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private generateAccessToken(user: Pick<User, 'id' | 'email' | 'role' | 'orgId'>): string {
    return this.jwtService.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        orgId: user.orgId,
      },
      {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.configService.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
      },
    );
  }

  private async issueRefreshToken(userId: string): Promise<string> {
    const random = crypto.randomBytes(48).toString('hex');
    const rawToken = `${Buffer.from(userId).toString('base64url')}.${random}`;
    const tokenHash = this.hashOpaqueToken(rawToken);

    const refreshExpiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d');
    const expiresAt = new Date(Date.now() + this.parseDurationMs(refreshExpiresIn));

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
      },
    });

    return rawToken;
  }

  private parseDurationMs(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration.trim());
    if (!match) {
      return 7 * 24 * 60 * 60 * 1000;
    }
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return value * unitMs[unit];
  }

  /** Single login for every role, SUPER_ADMIN included. */
  async login(dto: LoginDto): Promise<TokenPair & { user: Partial<User> }> {
    return this.authenticate(dto, () => true);
  }

  /** Super admin portal login — only SUPER_ADMIN accounts may authenticate here. */
  async superAdminLogin(dto: LoginDto): Promise<TokenPair & { user: Partial<User> }> {
    return this.authenticate(dto, (role) => role === Role.SUPER_ADMIN);
  }

  private async authenticate(
    dto: LoginDto,
    isRoleAllowed: (role: Role) => boolean,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase(), status: UserStatus.ACTIVE, deletedAt: null },
      include: { org: { select: { isActive: true } } },
    });

    // Always run bcrypt so unknown emails take as long as wrong passwords
    // (no account enumeration through response timing).
    const passwordMatches = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !isRoleAllowed(user.role) || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.org && !user.org.isActive) {
      throw new UnauthorizedException('Your organization’s account is not active. Please contact support.');
    }

    if (!user.isVerified) {
      throw new UnauthorizedException('Please verify your account using the link emailed to you before logging in.');
    }

    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.issueRefreshToken(user.id);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.configService.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
      },
    };
  }

  async refresh(dto: RefreshTokenDto): Promise<TokenPair> {
    const parts = dto.refreshToken.split('.');
    if (parts.length !== 2) {
      throw new UnauthorizedException('Malformed refresh token');
    }

    let userId: string;
    try {
      userId = Buffer.from(parts[0], 'base64url').toString('utf-8');
    } catch {
      throw new UnauthorizedException('Malformed refresh token');
    }

    const tokenHash = this.hashOpaqueToken(dto.refreshToken);

    const storedToken = await this.prisma.refreshToken.findFirst({
      where: { userId, tokenHash },
    });

    if (storedToken?.revokedAt) {
      // A rotated token came back. Within a short grace window that is two
      // browser tabs refreshing at once; later it means the token was copied,
      // so every session of this user is ended.
      if (Date.now() - storedToken.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
        await this.prisma.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    if (!storedToken || storedToken.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { org: { select: { isActive: true } } },
    });
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt || (user.org && !user.org.isActive)) {
      throw new UnauthorizedException('User no longer active');
    }

    // Rotate: revoke the used token and issue a fresh pair. The conditional
    // update makes two parallel refreshes of one token yield one winner.
    const rotated = await this.prisma.refreshToken.updateMany({
      where: { id: storedToken.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (rotated.count === 0) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.issueRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.configService.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
    };
  }

  async logout(dto: RefreshTokenDto): Promise<{ success: boolean }> {
    const parts = dto.refreshToken.split('.');
    if (parts.length !== 2) {
      throw new BadRequestException('Malformed refresh token');
    }
    const userId = Buffer.from(parts[0], 'base64url').toString('utf-8');
    const tokenHash = this.hashOpaqueToken(dto.refreshToken);

    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { success: result.count > 0 };
  }

  /**
   * Consumes an emailed verification token. For ORG_ADMIN_VERIFY tokens this
   * also marks the organization itself verified, since the org was created
   * together with this admin and has nothing else to verify.
   */
  async verifyEmail(dto: VerifyEmailDto): Promise<{ success: boolean }> {
    const { userId, type, orgId } = await this.verificationService.consumeToken(dto.token);

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { isVerified: true, verifiedAt: new Date() },
      });

      if (type === VerificationTokenType.ORG_ADMIN_VERIFY && orgId) {
        await tx.organization.update({
          where: { id: orgId },
          data: { isVerified: true, verifiedAt: new Date() },
        });
      }

      // SUPER_ADMIN has no org, so there is no org-scoped bell to notify.
      if (user.orgId) await tx.notification.create({
        data: {
          orgId: user.orgId,
          userId: user.id,
          type: NotificationType.GENERIC,
          title: 'Account verified',
          message: 'Your account has been verified. You can now log in.',
        },
      });
    });

    return { success: true };
  }

  /**
   * Returns a generic success response whether or not the email matches an
   * account, to avoid leaking which emails are registered — but reports an
   * outright mail failure, since otherwise the user waits for a code that is
   * never coming.
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ success: boolean }> {
    // Checked before the lookup so an unconfigured mailer fails identically
    // for registered and unregistered emails, keeping the generic response
    // below meaningful.
    if (!this.mailService.isConfigured) {
      throw passwordResetUnavailable('email delivery is not configured on the server');
    }

    const user = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase(), status: UserStatus.ACTIVE, deletedAt: null },
      include: { org: { select: { name: true } } },
    });

    if (user) {
      const otp = await this.verificationService.issueOtp(user.id);
      try {
        await this.mailService.sendPasswordResetOtp({
          to: user.email,
          name: user.name,
          otp,
          // Super Admins sit inside a seeded org that means nothing to them, so
          // they get platform branding instead of that org's name.
          orgName: user.role === Role.SUPER_ADMIN ? null : (user.org?.name ?? null),
        });
      } catch (error) {
        if (error instanceof MailDeliveryException) {
          throw passwordResetUnavailable(error.reason);
        }
        throw error;
      }
    }

    return { success: true };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ success: boolean }> {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase(), status: UserStatus.ACTIVE, deletedAt: null },
    });

    if (!user) {
      throw new BadRequestException('Incorrect OTP.');
    }

    await this.verificationService.verifyOtp(user.id, dto.otp);

    const passwordHash = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, isTemporaryPassword: false },
      });

      // An OTP reset implies the account may have been recovered from a
      // compromised state — revoke every existing session, unlike an
      // in-session profile password change which keeps the current one alive.
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // SUPER_ADMIN has no org, so there is no org-scoped bell to notify.
      if (user.orgId) await tx.notification.create({
        data: {
          orgId: user.orgId,
          userId: user.id,
          type: NotificationType.GENERIC,
          title: 'Password reset',
          message: 'Your password was reset using the OTP sent to your email.',
        },
      });
    });

    return { success: true };
  }
}
