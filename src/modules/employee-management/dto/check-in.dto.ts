import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsOptional } from 'class-validator';

export class CheckInDto {
  @ApiProperty({ required: false, example: 22.7196 })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiProperty({ required: false, example: 75.8577 })
  @IsOptional()
  @IsLongitude()
  lng?: number;
}
