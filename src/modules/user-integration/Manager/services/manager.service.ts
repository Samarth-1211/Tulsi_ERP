import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { Prisma, User, Role, UserStatus, VerificationTokenType } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../../common/decorators/current-user.decorator';
import { MailService } from '../../../mail/mail.service';
import { VerificationService } from '../../../verification/verification.service';
import { LeadAssignmentService } from '../../../lead-ingestion/services/lead-assignment.service';
import { UserDeletionService } from '../../../../common/services/user-deletion.service';
import { DeleteUserDto } from '../../SuperAdmin/dto/delete-user.dto';
import { CreateTeamMemberDto } from '../dto/create-team-member.dto';
import { UpdateTeamMemberDto } from '../dto/update-team-member.dto';
import { TeamMemberQueryDto } from '../dto/team-member-query.dto';
import { TeamMemberResponseDto } from '../dto/team-response-dto';

// Roles a manager is allowed to create/see/manage under this module.
export const MANAGEABLE_ROLES: Role[] = [Role.CALLER, Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF];
const SALT_ROUNDS = 12;

@Injectable()
export class ManagerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadAssignment: LeadAssignmentService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly verificationService: VerificationService,
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

  async createTeamMember(actor: AuthenticatedUser, dto: CreateTeamMemberDto): Promise<TeamMemberResponseDto> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        orgId: actor.orgId,
        email: dto.email,
        passwordHash,
        name: dto.name,
        phone: dto.phone,
        role: dto.role,
        managerId: actor.userId,
        createdById: actor.userId,
        ...this.verificationService.initialVerification(),
        isTemporaryPassword: true,
      },
    });

    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId } });
    // The member row is already committed — a failed invite email is reported
    // as a warning on the response rather than thrown, so the caller doesn't
    // retry and create a duplicate.
    const token = await this.verificationService.issueToken(user.id, VerificationTokenType.USER_VERIFY);
    const emailDelivery = await this.mailService.attempt(() =>
      this.mailService.sendTeamMemberInvite({
        to: user.email,
        name: user.name,
        orgName: organization.name,
        roleLabel: dto.role,
        tempPassword: dto.password,
        verifyUrl: this.buildVerifyUrl(token),
      }),
    );

    return { ...this.toTeamMemberResponse(user), emailDelivery };
  }

  /** Resends a fresh 24h verification link to a team member who hasn't verified yet. */
  async resendVerification(actor: AuthenticatedUser, id: string): Promise<{ success: boolean }> {
    const member = await this.assertOwnsTeamMember(actor, id);
    if (member.isVerified) {
      throw new ConflictException('This team member has already verified their account');
    }

    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId } });
    const token = await this.verificationService.issueToken(member.id, VerificationTokenType.USER_VERIFY);
    await this.mailService.sendVerificationReminder({
      to: member.email,
      name: member.name,
      orgName: organization.name,
      verifyUrl: this.buildVerifyUrl(token),
      origin: 'organization',
    });

    return { success: true };
  }

  async findTeamMembers(actor: AuthenticatedUser, query: TeamMemberQueryDto) {
    const where: Prisma.UserWhereInput = {
      orgId: actor.orgId,
      managerId: actor.userId,
      role: { in: MANAGEABLE_ROLES },
      deletedAt: null,
    };

    if (query.role) where.role = query.role;
    if (query.isActive !== undefined) where.status = query.isActive ? UserStatus.ACTIVE : UserStatus.INACTIVE;

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items: items.map(({ passwordHash, ...rest }) => rest), total, page, pageSize };
  }

  async findOneTeamMember(actor: AuthenticatedUser, id: string): Promise<User> {
    return this.assertOwnsTeamMember(actor, id);
  }

  async updateTeamMember(actor: AuthenticatedUser, id: string, dto: UpdateTeamMemberDto): Promise<User> {
    await this.assertOwnsTeamMember(actor, id);

    return this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.isActive !== undefined ? { status: dto.isActive ? UserStatus.ACTIVE : UserStatus.INACTIVE } : {}),
      },
    });
  }

  async assignLeadToTeamMember(actor: AuthenticatedUser, leadId: string, teamMemberId: string) {
    // Ownership check: the target must be one of this manager's own team
    // members, not just any user in the org.
    await this.assertOwnsTeamMember(actor, teamMemberId);

    // Delegates to LeadAssignmentService so there is a single source
    // of truth for lead-assignment side effects (status transition +
    // activity log entry), rather than duplicating that logic here.
    return this.leadAssignment.reassign(actor, leadId, teamMemberId);
  }

  /**
   * The org's other active Managers, names only — the one thing a Manager
   * may do across teams is hand a lead over to another Manager, so this is
   * all they get to see of the other teams.
   */
  async findPeerManagers(actor: AuthenticatedUser) {
    return this.prisma.user.findMany({
      where: {
        orgId: actor.orgId,
        role: Role.MANAGER,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        id: { not: actor.userId },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /** What deleting this team member would hand over, and which teammates can take it. */
  async getTeamMemberDeletionImpact(actor: AuthenticatedUser, id: string) {
    await this.assertOwnsTeamMember(actor, id);
    const member = await this.userDeletionService.getDeletableUser(actor, id);
    return this.userDeletionService.getImpact(actor, member);
  }

  async deleteTeamMember(actor: AuthenticatedUser, id: string, dto: DeleteUserDto) {
    await this.assertOwnsTeamMember(actor, id);
    const member = await this.userDeletionService.getDeletableUser(actor, id);
    await this.userDeletionService.deleteUser(actor, member, dto);
    return { message: 'Team member deleted successfully', id };
  }

  private async assertOwnsTeamMember(actor: AuthenticatedUser, teamMemberId: string): Promise<User> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: teamMemberId,
        orgId: actor.orgId,
        managerId: actor.userId,
        role: { in: MANAGEABLE_ROLES },
        deletedAt: null,
      },
    });

    if (!user) {
      throw new NotFoundException('Team member not found under your management');
    }

    return user;
  }

  private toTeamMemberResponse(user: User): TeamMemberResponseDto {
    const { passwordHash, ...rest } = user;
    return { ...rest, isActive: user.status === UserStatus.ACTIVE };
  }
}