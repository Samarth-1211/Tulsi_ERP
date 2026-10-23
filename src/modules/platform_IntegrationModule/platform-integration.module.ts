import { Module } from '@nestjs/common';
import { PlatformIntegrationController } from './controllers/platform-integration.controller';
import { PlatformIntegrationService } from './services/platform-integration.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { LeadIngestionModule } from '../lead-ingestion/lead-ingestion.module';

@Module({
  imports: [LeadIngestionModule],
  controllers: [
    PlatformIntegrationController,
  ],
  providers: [PlatformIntegrationService, EncryptionService],
  exports: [PlatformIntegrationService],
})
export class PlatformIntegrationModule {}