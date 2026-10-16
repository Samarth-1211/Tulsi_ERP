import { Module } from '@nestjs/common';
import { ManagersController} from './controller/managers.controller';
import { ManagersService } from './services/managers.service';

@Module({
  controllers: [ManagersController],
  providers: [ManagersService],
  exports: [ManagersService],
})
export class OrgSpecificAdminModule {}
