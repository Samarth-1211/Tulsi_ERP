import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { Role } from '@prisma/client';

export class TeamMemberQueryDto {
  @IsOptional()
  @IsIn([Role.CALLER, Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF])
  role?: Role;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  pageSize?: number = 25;
}
