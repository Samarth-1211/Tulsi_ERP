import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';
import { EmployeeActivityType } from '@prisma/client';

export class LogActivityDto {
  @ApiProperty({ enum: EmployeeActivityType, example: EmployeeActivityType.CALL })
  @IsEnum(EmployeeActivityType)
  type!: EmployeeActivityType;

  @ApiProperty({
    required: false,
    example: 'Called lead Rahul about the Bandra 3BHK',
    description: 'Required when type is OTHER, optional (but encouraged) for the preset types',
  })
  @ValidateIf((dto: LogActivityDto) => dto.type === EmployeeActivityType.OTHER)
  @IsString()
  description?: string;

  @ApiProperty({ required: false, description: 'Optionally link this activity to a specific lead' })
  @IsOptional()
  @IsString()
  leadId?: string;
}
