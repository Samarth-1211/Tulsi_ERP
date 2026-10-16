import { Module } from '@nestjs/common';
import { FollowUpsController, LeadsController } from './controllers/leads.controller';
import { LeadsWebhookController } from './controllers/leads-webhook.controller';
import { LeadsService } from './services/leads.service';
import { LeadAllocationService } from './services/lead-allocation.service';
import { LeadsWebhookService } from './services/leads-webhook.service';
import { LeadDedupService } from './services/lead-dedup.service';
import { LeadNotificationsService } from './services/lead-notifications.service';
import { LeadImportService } from './services/lead-import.service';
import { LeadImportStorageService } from './services/lead-import-storage.service';
import { LeadIngestionService } from './services/lead-ingestion.service';
import { LeadAssignmentService } from './services/lead-assignment.service';
import { EncryptionService } from '../../common/crypto/encryption.service';

@Module({
  controllers: [LeadsController, FollowUpsController, LeadsWebhookController],
  providers: [
    LeadsService,
    LeadAllocationService,
    LeadsWebhookService,
    LeadDedupService,
    LeadNotificationsService,
    LeadImportService,
    LeadImportStorageService,
    LeadIngestionService,
    LeadAssignmentService,
    EncryptionService,
  ],
  exports: [LeadsService, LeadIngestionService, LeadAssignmentService, LeadAllocationService, LeadsWebhookService, LeadDedupService, LeadNotificationsService],
})
export class LeadIngestionModule {}
