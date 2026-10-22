import { Module } from '@nestjs/common';
import { TaskAllotmentController, TaskAllotmentSettingsController } from './controllers/task-allotment.controller';
import { TaskAllotmentService } from './services/task-allotment.service';

@Module({
  controllers: [TaskAllotmentController, TaskAllotmentSettingsController],
  providers: [TaskAllotmentService],
})
export class TaskAllotmentModule {}
