import { Module } from '@nestjs/common';
import { EmployeesController } from './controllers/employees.controller';
import { AttendanceController } from './controllers/attendance.controller';
import { LeaveController } from './controllers/leave.controller';
import { TargetsController } from './controllers/targets.controller';
import { ActivitiesController } from './controllers/activities.controller';
import { EmployeesService } from './services/employees.service';
import { AttendanceService } from './services/attendance.service';
import { LeaveService } from './services/leave.service';
import { TargetsService } from './services/targets.service';
import { ActivitiesService } from './services/activities.service';

@Module({
  controllers: [EmployeesController, AttendanceController, LeaveController, TargetsController, ActivitiesController],
  providers: [EmployeesService, AttendanceService, LeaveService, TargetsService, ActivitiesService],
  exports: [EmployeesService, AttendanceService, LeaveService, TargetsService, ActivitiesService],
})
export class EmployeeManagementModule {}
