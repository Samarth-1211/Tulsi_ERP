import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './common/config/env.validation';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { UserDeletionModule } from './common/services/user-deletion.module';
import { UserIntegrationModule } from './modules/user-integration/user-integration.module';
import { LeadIngestionModule } from './modules/lead-ingestion/lead-ingestion.module';
import { EmployeeManagementModule } from './modules/employee-management/employee-management.module';
import { PlatformIntegrationModule } from './modules/platform_IntegrationModule/platform-integration.module';
import { LeadAllocationAdminModule } from './modules/lead-allocation-admin/lead-allocation-admin.module';
import { WhatsAppIntegrationModule } from './modules/whatsapp-integration/whatsapp-integration.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MailModule } from './modules/mail/mail.module';
import { VerificationModule } from './modules/verification/verification.module';
import { InventoryModule } from './modules/inventory/inventory.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env', validate: validateEnv }),
    ScheduleModule.forRoot(),
    // Default: 600 requests/minute per user (or per IP when signed out).
    // Auth and public webhook routes set tighter limits with @Throttle.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }],
      errorMessage: 'Too many requests. Please wait a minute and try again.',
    }),
    PrismaModule,
    UserDeletionModule,
    MailModule,
    VerificationModule,
    UserIntegrationModule,
    LeadIngestionModule,
    PlatformIntegrationModule,
    EmployeeManagementModule,
    LeadAllocationAdminModule,
    WhatsAppIntegrationModule,
    TasksModule,
    NotificationsModule,
    DashboardModule,
    InventoryModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule {}
