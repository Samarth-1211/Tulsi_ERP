import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { User, Role, UserStatus, VerificationTokenType } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { AuthenticatedUser } from '../../../../common/decorators/current-user.decorator';
import { DeleteUserDto } from '../dto/delete-user.dto';
import { stripDeletedMarker, UserDeletionService } from '../../../../common/services/user-deletion.service';
import { MailService } from '../../../mail/mail.service';
import { VerificationService } from '../../../verification/verification.service';

const SALT_ROUNDS = 12;
const PRIVILEGED_ROLES: Role[] = [Role.SUPER_ADMIN, Role.ADMIN];

// Which roles a given role is permitted to create. SUPER_ADMIN creates an
// organization together with its ADMIN through /organizations, not here.
const CREATION_MATRIX: Record<Role, Role[]> = {
  SUPER_ADMIN: [],
  ADMIN: [Role.MANAGER, Role.CALLER, Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF],
  MANAGER: [Role.CALLER, Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF],
  CALLER: [],
  DELIVERY_PARTNER: [],
  WAREHOUSE_STAFF: [],
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userDeletionService: UserDeletionService,
    private readonly mailService: MailService,
    private readonly verificationService: VerificationService,
  ) {}

  private sanitize(user: User): Omit<User, 'passwordHash'> {
    const { passwordHash, ...rest } = user;
    return { ...rest, email: stripDeletedMarker(rest.email) };
  }

  async createUser(actor: AuthenticatedUser, dto: CreateUserDto) {
    const allowedRoles = CREATION_MATRIX[actor.role] ?? [];
    if (!allowedRoles.includes(dto.role)) {
      throw new ForbiddenException(
        `A user with role ${actor.role} cannot create accounts with role ${dto.role}`,
      );
    }

    let managerId: string | null = null;

    if (actor.role === Role.MANAGER) {
      // Managers may only build their own team.
      managerId = actor.userId;
    } else if (dto.managerId) {
      const manager = await this.prisma.user.findFirst({
        where: { id: dto.managerId, orgId: actor.orgId, role: Role.MANAGER, deletedAt: null },
      });
      if (!manager) {
        throw new BadRequestException('managerId does not reference a manager in your organization');
      }
      managerId = manager.id;
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const created = await this.prisma.user.create({
      data: {
        orgId: actor.orgId,
        email: dto.email.toLowerCase(),
        passwordHash,
        name: dto.name,
        phone: dto.phone,
        role: dto.role,
        createdById: actor.userId,
        managerId,
        ...this.verificationService.initialVerification(),
        isTemporaryPassword: true,
      },
    });

    // The user row is committed — a failed invite email is reported on the
    // response rather than thrown, so the caller doesn't retry into a duplicate.
    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId } });
    const token = await this.verificationService.issueToken(created.id, VerificationTokenType.USER_VERIFY);
    const emailDelivery = await this.mailService.attempt(() =>
      this.mailService.sendTeamMemberInvite({
        to: created.email,
        name: created.name,
        orgName: organization.name,
        roleLabel: dto.role,
        tempPassword: dto.password,
        verifyUrl: this.verificationService.buildVerifyUrl(token),
      }),
    );

    return { ...this.sanitize(created), emailDelivery };
  }

  /**
   * Lists the org's users (a Manager only sees their own team). `deleted`
   * switches to the archive of deleted accounts, Admin-only, so their
   * history (attendance, leads, activity) can still be opened.
   */
  async findAll(actor: AuthenticatedUser, deleted = false): Promise<Omit<User, 'passwordHash'>[]> {
    if (deleted && !PRIVILEGED_ROLES.includes(actor.role)) {
      throw new ForbiddenException('Only Admins or Super Admins can view deleted users');
    }

    const where =
      actor.role === Role.MANAGER
        ? { orgId: actor.orgId, managerId: actor.userId, deletedAt: deleted ? { not: null } : null }
        : { orgId: actor.orgId, deletedAt: deleted ? { not: null } : null };

    const users = await this.prisma.user.findMany({
      where,
      orderBy: deleted ? { deletedAt: 'desc' } : { createdAt: 'desc' },
    });
    return users.map((u: User) => this.sanitize(u));
  }

  async findOne(actor: AuthenticatedUser, id: string): Promise<Omit<User, 'passwordHash'>> {
    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user || user.orgId !== actor.orgId) {
      throw new NotFoundException('User not found');
    }

    if (actor.role === Role.MANAGER && user.managerId !== actor.userId && user.id !== actor.userId) {
      throw new ForbiddenException('You may only view members of your own team');
    }

    return this.sanitize(user);
  }

  private async findManageable(actor: AuthenticatedUser, id: string) {
    if (!PRIVILEGED_ROLES.includes(actor.role)) {
      throw new ForbiddenException('Only Admins or Super Admins can change account status');
    }

    const target = await this.findOne(actor, id);
    if (target.deletedAt) {
      throw new NotFoundException('User not found');
    }
    if (target.id === actor.userId) {
      throw new ForbiddenException('You cannot change the status of your own account');
    }
    return target;
  }

  async deactivate(actor: AuthenticatedUser, id: string): Promise<Omit<User, 'passwordHash'>> {
    const target = await this.findManageable(actor, id);
    if (target.status !== UserStatus.ACTIVE) {
      throw new ConflictException('User is already deactivated');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: target.id }, data: { status: UserStatus.INACTIVE } }),
      this.prisma.userAuditLog.create({
        data: { action: 'ADMIN_DEACTIVATED', performedById: actor.userId, targetUserId: target.id },
      }),
    ]);

    return this.sanitize(updated);
  }

  async reactivate(actor: AuthenticatedUser, id: string): Promise<Omit<User, 'passwordHash'>> {
    const target = await this.findManageable(actor, id);
    if (target.status === UserStatus.ACTIVE) {
      throw new ConflictException('User is already active');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: target.id }, data: { status: UserStatus.ACTIVE } }),
      this.prisma.userAuditLog.create({
        data: { action: 'ADMIN_REACTIVATED', performedById: actor.userId, targetUserId: target.id },
      }),
    ]);

    return this.sanitize(updated);
  }

  /** What deleting this user would hand over, and to whom it can go — drives the delete dialog. */
  async getDeletionImpact(actor: AuthenticatedUser, id: string) {
    const target = await this.userDeletionService.getDeletableUser(actor, id);
    return this.userDeletionService.getImpact(actor, target);
  }

  async deleteUser(actor: AuthenticatedUser, id: string, dto: DeleteUserDto) {
    const target = await this.userDeletionService.getDeletableUser(actor, id);
    await this.userDeletionService.deleteUser(actor, target, dto);
    return { message: 'User deleted successfully', id };
  }
}
