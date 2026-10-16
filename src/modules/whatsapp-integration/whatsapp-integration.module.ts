import { Module } from '@nestjs/common';
import { LeadIngestionModule } from '../lead-ingestion/lead-ingestion.module';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { WhatsAppIntegrationController } from './controllers/whatsapp-integration.controller';
import { WhatsAppWebhookController } from './controllers/whatsapp-webhook.controller';
import { WhatsAppChatController, WhatsAppInboxController } from './controllers/whatsapp-chat.controller';
import { WhatsAppDebugController } from './controllers/whatsapp-debug.controller';
import { WhatsAppIntegrationService } from './services/whatsapp-integration.service';
import { WhatsAppWebhookService } from './services/whatsapp-webhook.service';
import { WhatsAppMessagingService } from './services/whatsapp-messaging.service';
import { MetaWhatsAppClientService } from './services/meta-whatsapp-client.service';
import { WhatsAppMediaStorageService } from './services/whatsapp-media-storage.service';
import { WhatsAppDebugService } from './services/whatsapp-debug.service';
import { WhatsAppAdSourcesController } from './controllers/whatsapp-ad-sources.controller';
import { WhatsAppAdSourceService } from './services/whatsapp-ad-source.service';

@Module({
  // Needs LeadAllocationService to auto-assign leads captured from inbound
  // WhatsApp messages, exactly like the existing webhook ingestion flow.
  imports: [LeadIngestionModule],
  controllers: [
    WhatsAppIntegrationController,
    WhatsAppWebhookController,
    WhatsAppChatController,
    WhatsAppInboxController,
    WhatsAppDebugController,
    WhatsAppAdSourcesController,
  ],
  providers: [
    WhatsAppAdSourceService,
    WhatsAppIntegrationService,
    WhatsAppWebhookService,
    WhatsAppMessagingService,
    MetaWhatsAppClientService,
    WhatsAppMediaStorageService,
    WhatsAppDebugService,
    EncryptionService,
  ],
})
export class WhatsAppIntegrationModule {}
