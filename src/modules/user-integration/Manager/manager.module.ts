import { Module } from '@nestjs/common';
import { LeadIngestionModule } from '../../lead-ingestion/lead-ingestion.module';
import { ManagerController } from './controller/manager.controller';
import { ManagerService } from './services/manager.service';

// PrismaService is assumed to come from a @Global() PrismaModule — if it
// isn't global in your app, add PrismaModule to the imports array below,
// e.g. `import { PrismaModule } from '../../../prisma/prisma.module';`
@Module({
  imports: [LeadIngestionModule],
  controllers: [ManagerController],
  providers: [ManagerService],
})
export class ManagerModule {}