import { StrongPassword } from '../../../../common/validators/strong-password.decorator';
import { IsEmail, IsIn, IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { Role } from '@prisma/client';

// Deliberately IsIn (not IsEnum against full Role) — a manager must
// never be able to create a MANAGER/ADMIN/SUPER_ADMIN account via this DTO.
export class CreateTeamMemberDto {
  // Lower-cased on the way in: login looks the account up by
  // email.toLowerCase(), so an address stored with any capitals could never
  // be signed into.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @IsString()
  @StrongPassword()
  password!: string;

  @IsString()
  name!: string;

  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone!: string;

  @IsIn([Role.CALLER, Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF])
  role!: Role;
}
