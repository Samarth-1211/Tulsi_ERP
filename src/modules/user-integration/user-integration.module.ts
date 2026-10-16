import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './SuperAdmin/controllers/auth.controller';
import { UsersController } from './SuperAdmin/controllers/users.controller';
import { OrganizationsController } from './SuperAdmin/controllers/organizations.controller';
import { AuthService } from './SuperAdmin/services/auth.service';
import { UsersService } from './SuperAdmin/services/users.service';
import { OrganizationsService } from './SuperAdmin/services/organizations.service';
import { JwtStrategy } from './SuperAdmin/services/jwt.strategy';
import { OrgSpecificAdminModule } from './org_specific_admin/org-specific-admin.module';
import { ManagerModule } from './Manager/manager.module';



@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
        signOptions: { expiresIn: config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m') },
      }),
      
    }),
    OrgSpecificAdminModule,
      ManagerModule
  ],
  controllers: [AuthController, UsersController, OrganizationsController],
  providers: [AuthService, UsersService, OrganizationsService, JwtStrategy],
  exports: [UsersService, OrganizationsService],
})
export class UserIntegrationModule {}