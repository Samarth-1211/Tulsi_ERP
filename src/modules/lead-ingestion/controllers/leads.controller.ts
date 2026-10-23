import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { LeadImportAllocationMode, Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { LeadsService } from '../services/leads.service';
import { LeadAssignmentService } from '../services/lead-assignment.service';
import { LeadImportService } from '../services/lead-import.service';
import { MAX_IMPORT_FILE_BYTES } from '../utils/lead-import.util';
import { contentDisposition } from '../../../common/utils/upload.util';
import { ImportLeadsDto } from '../dto/import-leads.dto';
import { LeadImportQueryDto } from '../dto/lead-import-query.dto';
import { CreateLeadManualDto } from '../dto/create-lead-manual.dto';
import { AssignLeadDto } from '../dto/assign-lead.dto';
import { UpdateLeadStatusDto } from '../dto/update-lead-status.dto';
import { CreateFollowUpDto } from '../dto/create-follow-up.dto';
import { AddLeadNoteDto } from '../dto/add-lead-note.dto';
import { LeadQueryDto } from '../dto/lead-querry-dto';
import { ShuffleLostLeadsDto } from '../dto/shuffle-lost-leads.dto';
import { DeleteLeadDto } from '../dto/delete-lead.dto';
import { BulkDeleteLeadsDto } from '../dto/bulk-delete-leads.dto';
import { BulkAssignLeadsDto } from '../dto/bulk-assign-leads.dto';
import { UpdateLeadDetailsDto } from '../dto/update-lead-details.dto';

// Every lead route: Admin, Manager, Caller (scoped in the service). Delivery and
// warehouse staff have no lead access in Phase 1.
const LEAD_ROLES = [Role.ADMIN, Role.MANAGER, Role.CALLER];

@ApiTags('leads')
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly leadAssignment: LeadAssignmentService,
    private readonly leadImportService: LeadImportService,
    private readonly configService: ConfigService,
  ) {}

  @Post('import')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiBearerAuth('access-token')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_FILE_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        allocationMode: { type: 'string', enum: Object.values(LeadImportAllocationMode) },
        managerIds: { type: 'array', items: { type: 'string' } },
        customAllocations: { type: 'string', description: 'JSON array of { userId, count }' },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload leads from an Excel (.xlsx) or CSV sheet (Admin or Manager)',
    description:
      'The file is checked immediately and kept for the Admin to download; its rows are then imported in the ' +
      "background. `allocationMode` says who gets the leads: every Manager's presales team (ALL_TEAMS), or the " +
      'Managers named in `managerIds` — each an equal share, kept to themselves (MANAGERS_ONLY) or spread across ' +
      'themselves and their presales team (MANAGERS_AND_TEAMS) — or the people in `customAllocations`, each with ' +
      'their own number of leads (CUSTOM). Poll GET /leads/imports/:id for progress and the per-row outcome.',
  })
  importLeads(
    @CurrentUser() actor: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ImportLeadsDto,
  ) {
    return this.leadImportService.startImport(actor, file, dto);
  }

  @Post('import/preview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiBearerAuth('access-token')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_FILE_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({
    summary: 'Count the leads in a sheet before uploading it (Admin or Manager)',
    description:
      'Reads the sheet without saving anything and reports how many rows would become new leads, how many are ' +
      'already in the CRM (or repeat an earlier row) and how many can’t be read — what a custom split has to give out.',
  })
  previewImport(@CurrentUser() actor: AuthenticatedUser, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.leadImportService.previewImport(actor, file);
  }

  @Get('import/template')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiBearerAuth('access-token')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @Header('Content-Disposition', 'attachment; filename="lead-upload-template.xlsx"')
  @ApiOperation({ summary: 'Download the Excel template for uploading leads (Admin or Manager)' })
  async importTemplate() {
    return new StreamableFile(await this.leadImportService.buildTemplate());
  }

  @Get('imports')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Every uploaded lead sheet, newest first — who uploaded it, when, who it was shared with and its outcome (Admin only)',
  })
  listImports(@CurrentUser() actor: AuthenticatedUser, @Query() query: LeadImportQueryDto) {
    return this.leadImportService.listBatches(actor, query.page, query.pageSize);
  }

  @Get('imports/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Progress and outcome of a lead upload (Admin, or the Manager who uploaded it)' })
  getImport(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.leadImportService.getBatch(actor, id);
  }

  @Get('imports/:id/file')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Download an uploaded lead sheet exactly as it was uploaded (Admin only)' })
  async downloadImportFile(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.leadImportService.openFile(actor, id);
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.size,
      disposition: contentDisposition('attachment', file.fileName),
    });
  }

  @Delete('imports/:id/leads')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Soft-delete every lead that came from one uploaded Excel sheet (Admin only)',
    description: 'The upload stays in the upload history. The body must carry `confirmation: "delete"`.',
  })
  removeImportLeads(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() _dto: DeleteLeadDto) {
    return this.leadsService.removeImportBatchLeads(actor, id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.CALLER)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Manually create a lead (MANUAL / WALK_IN / REFERRAL / OTHER)',
    description:
      'Admin: assignToId or round robin. Manager: self or own team (default self). Caller: always self. ' +
      'A phone with an open lead becomes a re-enquiry on it (deduplicated: true).',
  })
  createManual(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateLeadManualDto) {
    return this.leadsService.createManual(actor, dto);
  }

  @Patch(':id/assign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Manually (re)assign a lead',
    description:
      'Admin: any lead to any active user in the org. Manager: own or team leads, to self or own team. ' +
      'Writes a MANUAL LeadAssignment + REASSIGNED activity and notifies the new assignee.',
  })
  assign(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: AssignLeadDto) {
    return this.leadAssignment.reassign(actor, id, dto.toUserId, dto.reason);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Change a lead's status (Admin: any; Manager: own + team's; Caller: own)",
    description: 'CONVERTED requires `note` and sets convertedAt; LOST requires `lostReason`. Writes STATUS_CHANGED { from, to }.',
  })
  updateStatus(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateLeadStatusDto) {
    return this.leadsService.updateStatus(actor, id, dto);
  }

  @Post(':id/follow-ups')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Log a follow-up — sets nextFollowUpAt / lastActivityAt and writes a FOLLOW_UP activity' })
  addFollowUp(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: CreateFollowUpDto) {
    return this.leadsService.addFollowUp(actor, id, dto);
  }

  @Post(':id/notes')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "Add a note to the lead's timeline — from a Manager/Admin it also notifies the assignee" })
  addNote(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: AddLeadNoteDto) {
    return this.leadsService.addNote(actor, id, dto.note);
  }

  @Get(':id/activities')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "The lead's timeline (activity log), newest first" })
  listActivities(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.listActivities(actor, id);
  }

  @Post('lost/shuffle')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Manually shuffle lost leads to different team members (never back to whoever lost them) — omit leadIds to shuffle every lost lead in scope',
  })
  shuffleLostLeads(@CurrentUser() actor: AuthenticatedUser, @Body() dto: ShuffleLostLeadsDto) {
    return this.leadAssignment.shuffleLostLeads(actor, dto.leadIds);
  }

  @Post('bulk-assign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Assign several leads to one person at once',
    description:
      'Same rules as PATCH /leads/:id/assign, checked per lead — any lead that can’t be moved is skipped and listed ' +
      'in `skipped` with the reason. Admins can move leads to anyone in the org; Managers to themselves or their team.',
  })
  bulkAssign(@CurrentUser() actor: AuthenticatedUser, @Body() dto: BulkAssignLeadsDto) {
    return this.leadAssignment.reassignMany(actor, dto.leadIds, dto.toUserId, dto.reason);
  }

  @Post('bulk-delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Soft-delete several leads at once (Admin only)',
    description: 'Unknown ids are skipped. The body must carry `confirmation: "delete"`.',
  })
  bulkDelete(@CurrentUser() actor: AuthenticatedUser, @Body() dto: BulkDeleteLeadsDto) {
    return this.leadsService.removeMany(actor, dto.leadIds);
  }

  @Get('team-performance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Per-caller leads, open, converted, lost, conversion % and overdue follow-ups (Manager: own team)' })
  getTeamPerformance(@CurrentUser() actor: AuthenticatedUser) {
    return this.leadsService.getTeamPerformance(actor);
  }

  // Declared before `GET :id` so "unseen-count" isn't captured as a lead id.
  @Get('unseen-count')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Count leads that arrived since the caller last opened the Leads list (the "new leads" nav dot)' })
  countUnseen(@CurrentUser() actor: AuthenticatedUser) {
    return this.leadsService.countUnseen(actor);
  }

  // Declared before `GET :id` so it isn't captured as a lead id.
  @Get('filter-options')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Values in use for the Buying For and Requirement filters with lead counts; ad ids for an Admin' })
  filterOptions(@CurrentUser() actor: AuthenticatedUser) {
    return this.leadsService.filterOptions(actor);
  }

  // Declared before `GET :id` so "cities" isn't captured as a lead id.
  @Get('cities')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Every city the org’s leads have come from, A–Z (options for the City filter)' })
  listCities(@CurrentUser() actor: AuthenticatedUser) {
    return this.leadsService.listCities(actor);
  }

  @Patch('seen')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Mark the Leads list as seen by the caller (clears the "new leads" nav dot)' })
  markSeen(@CurrentUser() actor: AuthenticatedUser) {
    return this.leadsService.markSeen(actor);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List leads (Admin: org; Manager: own + team; Caller: own)',
    description:
      'Filters: status, source, assignedToId, city, buyingFor, requirement, hasFeedback, from/to (lead date), ' +
      'search (name/phone), adId (Admin); sort newest | oldest | ad (Admin); page/pageSize.',
  })
  findAll(@CurrentUser() actor: AuthenticatedUser, @Query() query: LeadQueryDto) {
    return this.leadsService.findAll(actor, query);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'One lead with assignee, attribution, recent follow-ups and counts' })
  findOne(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.findOne(actor, id);
  }

  // Declared after `PATCH seen` so "seen" isn't captured as a lead id.
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Edit a lead's fields (Admin: any; Manager: own + team's; Caller: own)",
    description: "Writes an UPDATED activity; the org's Admins are notified of exactly what changed.",
  })
  updateDetails(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateLeadDetailsDto) {
    return this.leadsService.updateDetails(actor, id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Soft-delete a lead (Admin only)',
    description: 'Sets deletedAt and writes a DELETED activity. The body must carry `confirmation: "delete"`.',
  })
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() _dto: DeleteLeadDto) {
    return this.leadsService.remove(actor, id);
  }
}

/** GET /follow-ups/today — due today (overdue included) for the caller, a Manager's team, or an Admin's org. */
@ApiTags('leads')
@Controller('follow-ups')
export class FollowUpsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get('today')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LEAD_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "Today's pending follow-ups (Caller: own leads; Manager: own + team; Admin: org)" })
  today(@CurrentUser() actor: AuthenticatedUser) {
    return this.leadsService.followUpsDueToday(actor);
  }
}
