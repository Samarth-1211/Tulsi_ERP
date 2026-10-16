import { Global, Module } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { EmailChangeService } from './email-change.service';

@Global()
@Module({
  providers: [VerificationService, EmailChangeService],
  exports: [VerificationService, EmailChangeService],
})
export class VerificationModule {}
