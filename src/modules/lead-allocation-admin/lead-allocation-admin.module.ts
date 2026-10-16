import { Module } from '@nestjs/common';
import { LeadAllocationSettingsController } from './lead-allocation-settings.controller';
import { LeadAllocationSettingsService } from './lead-allocation-settings.service';

@Module({
  controllers: [LeadAllocationSettingsController],
  providers: [LeadAllocationSettingsService],
})
export class LeadAllocationAdminModule {}