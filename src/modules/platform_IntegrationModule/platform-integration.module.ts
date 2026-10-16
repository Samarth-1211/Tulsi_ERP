import { Module } from '@nestjs/common';
import { PlatformIntegrationController } from './controllers/platform-integration.controller';
import { PlatformIntegrationService } from './services/platform-integration.service';
import { EncryptionService } from '../../common/crypto/encryption.service';

@Module({
  controllers: [
    PlatformIntegrationController,
  ],
  providers: [PlatformIntegrationService, EncryptionService],
  exports: [PlatformIntegrationService],
})
export class PlatformIntegrationModule {}