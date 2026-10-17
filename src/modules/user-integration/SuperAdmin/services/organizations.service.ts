import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role, UserStatus, VerificationTokenType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../../prisma/prisma.service';
import { searchKeyFilter } from '../../../../common/utils/phonetic-key.util';
import { AuthenticatedUser } from '../../../../common/decorators/current-user.decorator';
import { EmailDeliveryStatus, MailService } from '../../../mail/mail.service';
import { VerificationService } from '../../../verification/verification.service';
import { CreateOrganizationDto } from '../dto/organisations.dto';
import { UpdateOrganizationDto } from '../dto/update-organization.dto';
import { SuspendOrganizationDto } from '../dto/suspend-organization.dto';
import { ReactivateOrganizationDto } from '../dto/reactivate-organization.dto';
import { ListOrganizationsQueryDto } from '../dto/list-organizations-query.dto';
import { CreateOrgAdminDto } from '../dto/create-org-admin.dto';

const SALT_ROUNDS = 12;

@Injectable()
export class OrganizationsService {
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

  private assertSuperAdmin(actor: AuthenticatedUser) {
    if (actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only a Super Admin can manage organizations');
    }
  }

  private async generateUniqueSlug(name: string): Promise<string> {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '');

    let slug = base;
    let suffix = 1;

    while (await this.prisma.organization.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }

    return slug;
  }

  async createOrganization(actor: AuthenticatedUser, dto: CreateOrganizationDto) {
    this.assertSuperAdmin(actor);

    const existingByEmail = await this.prisma.organization.findFirst({
      where: { email: dto.email },
    });
    if (existingByEmail) {
      throw new ConflictException('An organization with this contact email already exists');
    }

    const slug = await this.generateUniqueSlug(dto.name);

    // Every organization is created with its first admin, so the welcome +
    // verification email always has a recipient and the org can never come
    // into existence already verified.
    const adminPasswordHash = await bcrypt.hash(dto.admin.adminPassword, SALT_ROUNDS);

    const { organization, admin } = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: dto.name,
          slug,
          email: dto.email,
          phone: dto.phone,
          address: dto.address,
          gstin: dto.gstin,
          city: dto.city,
          state: dto.state,
          // Pending until the admin created below clicks the link in their
          // verification email — unless AUTO_VERIFY_NEW_USERS is on (testing).
          ...this.verificationService.initialVerification(),
          settings: { create: {} },
        },
      });

      await tx.organizationAuditLog.create({
        data: {
          action: 'ORG_CREATED',
          orgId: org.id,
          performedById: actor.userId,
        },
      });

      const createdAdmin = await tx.user.create({
        data: {
          orgId: org.id,
          email: dto.admin.adminEmail,
          passwordHash: adminPasswordHash,
          name: dto.admin.adminName,
          role: Role.ADMIN,
          createdById: actor.userId,
          ...this.verificationService.initialVerification(),
          isTemporaryPassword: true,
        },
      });

      await tx.userAuditLog.create({
        data: {
          action: 'ADMIN_CREATED',
          performedById: actor.userId,
          targetUserId: createdAdmin.id,
        },
      });

      return { organization: org, admin: createdAdmin };
    });

    // The org and admin are already committed above, so a failed invite email
    // is reported alongside the created record rather than thrown — retrying
    // the request would otherwise duplicate the organization. The caller shows
    // this warning and can fall back to "resend verification".
    const token = await this.verificationService.issueToken(
      admin.id,
      VerificationTokenType.ORG_ADMIN_VERIFY,
      organization.id,
    );
    const emailDelivery: EmailDeliveryStatus = await this.mailService.attempt(() =>
      this.mailService.sendOrgAdminInvite({
        to: admin.email,
        orgName: organization.name,
        adminName: admin.name,
        tempPassword: dto.admin.adminPassword,
        verifyUrl: this.buildVerifyUrl(token),
      }),
    );

    return { ...organization, emailDelivery };
  }

  // Adds an Admin to an organization. Not restricted to "first" admin only —
  // an org can have as many Admins as needed, added at any time.
  async addAdmin(actor: AuthenticatedUser, orgId: string, dto: CreateOrgAdminDto) {
    this.assertSuperAdmin(actor);

    const organization = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const existingEmail = await this.prisma.user.findUnique({
      where: {
        email: dto.adminEmail,
      },
    });
    if (existingEmail) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.adminPassword, SALT_ROUNDS);

    const admin = await this.prisma.$transaction(async (tx) => {
      const newAdmin = await tx.user.create({
        data: {
          orgId,
          email: dto.adminEmail,
          passwordHash,
          name: dto.adminName,
          role: Role.ADMIN,
          createdById: actor.userId,
          ...this.verificationService.initialVerification(),
          isTemporaryPassword: true,
        },
      });

      await tx.userAuditLog.create({
        data: {
          action: 'ADMIN_CREATED',
          performedById: actor.userId,
          targetUserId: newAdmin.id,
        },
      });

      return newAdmin;
    });

    const token = await this.verificationService.issueToken(admin.id, VerificationTokenType.ORG_ADMIN_VERIFY, organization.id);
    const emailDelivery = await this.mailService.attempt(() =>
      this.mailService.sendOrgAdminInvite({
        to: admin.email,
        orgName: organization.name,
        adminName: admin.name,
        tempPassword: dto.adminPassword,
        verifyUrl: this.buildVerifyUrl(token),
      }),
    );

    return { ...admin, emailDelivery };
  }

  /** Resends a fresh 24h verification link to every not-yet-verified admin in this organization. */
  async resendAdminVerification(actor: AuthenticatedUser, orgId: string) {
    this.assertSuperAdmin(actor);

    const organization = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const pendingAdmins = await this.prisma.user.findMany({
      where: { orgId, role: Role.ADMIN, deletedAt: null, isVerified: false },
    });
    if (pendingAdmins.length === 0) {
      throw new ConflictException('There are no unverified admins in this organization');
    }

    for (const admin of pendingAdmins) {
      const token = await this.verificationService.issueToken(admin.id, VerificationTokenType.ORG_ADMIN_VERIFY, organization.id);
      await this.mailService.sendVerificationReminder({
        to: admin.email,
        name: admin.name,
        orgName: organization.name,
        verifyUrl: this.buildVerifyUrl(token),
        // Super Admin chasing an org admin — speaks as the platform.
        origin: 'platform',
      });
    }

    return { success: true };
  }

  async findAll(actor: AuthenticatedUser, query: ListOrganizationsQueryDto) {
    this.assertSuperAdmin(actor);

    const where: Prisma.OrganizationWhereInput = {};

    if (query.status === 'ACTIVE') {
      Object.assign(where, { isActive: true, archivedAt: null });
    } else if (query.status === 'SUSPENDED') {
      Object.assign(where, { isActive: false, archivedAt: null });
    } else if (query.status === 'ARCHIVED') {
      where.archivedAt = { not: null };
    }
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        ...(searchKeyFilter(query.search) ? [searchKeyFilter(query.search)!] : []),
      ];
    }

    return this.prisma.organization.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(actor: AuthenticatedUser, id: string) {
    this.assertSuperAdmin(actor);

    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return organization;
  }

  async updateOrganization(actor: AuthenticatedUser, id: string, dto: UpdateOrganizationDto) {
    this.assertSuperAdmin(actor);

    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.update({
        where: { id },
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          address: dto.address,
          gstin: dto.gstin,
          city: dto.city,
          state: dto.state,
        },
      });

      await tx.organizationAuditLog.create({
        data: {
          action: 'ORG_UPDATED',
          orgId: id,
          performedById: actor.userId,
        },
      });

      return org;
    });

    return updated;
  }

  async suspendOrganization(actor: AuthenticatedUser, id: string, dto: SuspendOrganizationDto) {
    this.assertSuperAdmin(actor);

    if (id === actor.orgId) {
      throw new ForbiddenException('Cannot suspend the organization your own account belongs to');
    }

    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }
    if (!organization.isActive) {
      throw new ConflictException('Organization is already suspended');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.update({
        where: { id },
        data: {
          isActive: false,
          suspendedAt: new Date(),
          suspendedReason: dto.reason,
        },
      });

      await tx.user.updateMany({
        where: { orgId: id, deletedAt: null },
        data: { status: UserStatus.INACTIVE },
      });

      await tx.organizationAuditLog.create({
        data: {
          action: 'ORG_SUSPENDED',
          orgId: id,
          performedById: actor.userId,
          reason: dto.reason,
        },
      });

      return org;
    });

    return result;
  }

  async reactivateOrganization(actor: AuthenticatedUser, id: string, dto: ReactivateOrganizationDto) {
    this.assertSuperAdmin(actor);

    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }
    if (organization.isActive || organization.archivedAt) {
      throw new ConflictException('Organization is not currently suspended');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.update({
        where: { id },
        data: {
          isActive: true,
          suspendedAt: null,
          suspendedReason: null,
        },
      });

      await tx.organizationAuditLog.create({
        data: {
          action: 'ORG_REACTIVATED',
          orgId: id,
          performedById: actor.userId,
          reason: dto.reason,
        },
      });

      return org;
    });

    return result;
  }

  async archiveOrganization(actor: AuthenticatedUser, id: string) {
    this.assertSuperAdmin(actor);

    if (id === actor.orgId) {
      throw new ForbiddenException('Cannot archive the organization your own account belongs to');
    }

    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }
    if (organization.archivedAt) {
      throw new ConflictException('Organization is already archived');
    }
    if (organization.isDemo) {
      throw new ForbiddenException('The demo organization cannot be archived');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.update({
        where: { id },
        data: { isActive: false, archivedAt: new Date() },
      });

      await tx.user.updateMany({
        where: { orgId: id, deletedAt: null },
        data: { status: UserStatus.INACTIVE },
      });

      await tx.organizationAuditLog.create({
        data: {
          action: 'ORG_ARCHIVED',
          orgId: id,
          performedById: actor.userId,
        },
      });

      return org;
    });

    return result;
  }
}
