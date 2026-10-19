import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Role, UserStatus } from '@prisma/client';
import { AuthenticatedUser } from '../../../../common/decorators/current-user.decorator';
import { PrismaService } from '../../../../prisma/prisma.service';

interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
  orgId: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    // A signed token is not enough: a deactivated/deleted user or a suspended
    // org must lose access at once, not when the token expires.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, deletedAt: true, org: { select: { isActive: true } } },
    });
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt || (user.org && !user.org.isActive)) {
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }

    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      // SUPER_ADMIN has no org: an empty orgId matches no tenant row, so org-scoped queries return nothing.
      orgId: payload.orgId ?? '',
    };
  }
}
