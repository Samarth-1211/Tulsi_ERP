import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role, UserStatus, VerificationTokenType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../../common/decorators/current-user.decorator';
import { MailService } from '../../../mail/mail.service';
import { VerificationService } from '../../../verification/verification.service';
import { EmailChangeService } from '../../../verification/email-change.service';
import { UserDeletionService } from '../../../../common/services/user-deletion.service';
import { CreateManagerDto } from '../dto/create-manager.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { DeleteManagerDto } from '../dto/delete-manager.dto';

const SALT_ROUNDS = 12;

@Injectable()
export class ManagersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly verificationService: VerificationService,
    private readonly emailChangeService: EmailChangeService,
    private readonly userDeletionService: UserDeletionService,
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

  private assertAdmin(actor: AuthenticatedUser) {
    if (actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Only an Admin can manage Managers');
    }
  }

  private async getOrgScopedManager(actor: AuthenticatedUser, id: string) {
    const manager = await this.prisma.user.findUnique({ where: { id } });

    if (
      !manager ||
      manager.deletedAt ||
      manager.orgId !== actor.orgId ||
      manager.role !== Role.MANAGER
    ) {
      throw new NotFoundException('Manager not found');
    }

    return manager;
  }

  async createManager(actor: AuthenticatedUser, dto: CreateManagerDto) {
    this.assertAdmin(actor);

    const existing = await this.prisma.user.findUnique({
      where: {
        email: dto.email,
      },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const { manager, organization } = await this.prisma.$transaction(async (tx) => {
      const newManager = await tx.user.create({
        data: {
          orgId: actor.orgId,
          email: dto.email,
          passwordHash,
          name: dto.name,
          phone: dto.phone,
          role: Role.MANAGER,
          createdById: actor.userId,
          ...this.verificationService.initialVerification(),
          isTemporaryPassword: true,
        },
      });

      await tx.userAuditLog.create({
        data: {
          action: 'ADMIN_CREATED', // reused enum value — see note on Manager-specific actions
          performedById: actor.userId,
          targetUserId: newManager.id,
        },
      });

      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId } });

      return { manager: newManager, organization: org };
    });

    // Manager row is already committed — surface a failed invite email as a
    // warning on the response instead of failing the whole creation.
    const token = await this.verificationService.issueToken(manager.id, VerificationTokenType.USER_VERIFY);
    const emailDelivery = await this.mailService.attempt(() =>
      this.mailService.sendTeamMemberInvite({
        to: manager.email,
        name: manager.name,
        orgName: organization.name,
        roleLabel: 'Manager',
        tempPassword: dto.password,
        verifyUrl: this.buildVerifyUrl(token),
      }),
    );

    return { ...manager, emailDelivery };
  }

  /** Resends a fresh 24h verification link to a Manager who hasn't verified yet. */
  async resendVerification(actor: AuthenticatedUser, id: string) {
    this.assertAdmin(actor);

    const manager = await this.getOrgScopedManager(actor, id);
    if (manager.isVerified) {
      throw new ConflictException('This manager has already verified their account');
    }

    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId } });
    const token = await this.verificationService.issueToken(manager.id, VerificationTokenType.USER_VERIFY);
    await this.mailService.sendVerificationReminder({
      to: manager.email,
      name: manager.name,
      orgName: organization.name,
      verifyUrl: this.buildVerifyUrl(token),
      origin: 'organization',
    });

    return { success: true };
  }

  async findAll(actor: AuthenticatedUser) {
    this.assertAdmin(actor);

    return this.prisma.user.findMany({
      where: {
        orgId: actor.orgId,
        role: Role.MANAGER,
        deletedAt: null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        status: true,
        isVerified: true,
        verifiedAt: true,
        isTemporaryPassword: true,
        createdAt: true,
        createdById: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(actor: AuthenticatedUser, id: string) {
    this.assertAdmin(actor);
    return this.getOrgScopedManager(actor, id);
  }

  async updateManager(actor: AuthenticatedUser, id: string, dto: UpdateManagerDto) {
    this.assertAdmin(actor);
    const manager = await this.getOrgScopedManager(actor, id);

    // Re-sending the current address must not reset verification.
    const emailChanged = dto.email !== undefined && dto.email !== manager.email.toLowerCase();

    if (emailChanged) {
      const existing = await this.prisma.user.findUnique({
        where: {
          email: dto.email!,
        },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException('A user with this email already exists');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        phone: dto.phone,
      },
    });

    if (!emailChanged) {
      return updated;
    }

    const { user, emailDelivery } = await this.emailChangeService.changeEmail(id, dto.email!);
    return { ...user, emailDelivery };
  }

  async deactivateManager(actor: AuthenticatedUser, id: string) {
    this.assertAdmin(actor);
    const manager = await this.getOrgScopedManager(actor, id);

    if (manager.status !== UserStatus.ACTIVE) {
      throw new ConflictException('Manager is already deactivated');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { status: UserStatus.INACTIVE } }),
      this.prisma.userAuditLog.create({
        data: {
          action: 'ADMIN_DEACTIVATED', // reused enum value — see note on Manager-specific actions
          performedById: actor.userId,
          targetUserId: id,
        },
      }),
    ]);

    return { message: 'Manager deactivated successfully', id };
  }

  async reactivateManager(actor: AuthenticatedUser, id: string) {
    this.assertAdmin(actor);
    const manager = await this.getOrgScopedManager(actor, id);

    if (manager.status === UserStatus.ACTIVE) {
      throw new ConflictException('Manager is already active');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { status: UserStatus.ACTIVE } }),
      this.prisma.userAuditLog.create({
        data: {
          action: 'ADMIN_REACTIVATED', // reused enum value — see note on Manager-specific actions
          performedById: actor.userId,
          targetUserId: id,
        },
      }),
    ]);

    return { message: 'Manager reactivated successfully', id };
  }

  async deleteManager(actor: AuthenticatedUser, id: string, dto: DeleteManagerDto) {
    this.assertAdmin(actor);
    await this.getOrgScopedManager(actor, id);

    const manager = await this.userDeletionService.getDeletableUser(actor, id);
    await this.userDeletionService.deleteUser(actor, manager, dto);

    return { message: 'Manager deleted successfully', id };
  }
}
