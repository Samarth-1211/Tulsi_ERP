import { StrongPassword } from '../../../../common/validators/strong-password.decorator';
import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ example: 'agent@demorealty.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass@123' })
  @StrongPassword()
  password!: string;

  @ApiProperty({ example: 'Ramesh Kumar' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '+919876543210' })
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone!: string;

  @ApiProperty({ enum: Role, example: Role.CALLER })
  @IsEnum(Role)
  role!: Role;

  @ApiProperty({
    required: false,
    description:
      'Manager (role MANAGER) this CALLER, DELIVERY_PARTNER or WAREHOUSE_STAFF reports to. Ignored when a Manager creates the user (always self).',
  })
  @IsOptional()
  @IsString()
  managerId?: string;
}
