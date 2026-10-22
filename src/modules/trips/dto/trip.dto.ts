import { ApiProperty, PartialType } from '@nestjs/swagger';
import { TripLeadFilter, TripStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class TripStopDto {
  @ApiProperty({ example: 'Indore' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 22.7196 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ example: 75.8577 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}

export class PlanTripDto {
  @ApiProperty({ type: [TripStopDto], description: 'From, optional stops, To — in travel order' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TripStopDto)
  stops!: TripStopDto[];

  @ApiProperty({ required: false, minimum: 0, maximum: 100, default: 20, description: 'How far off the road (km) a city may be' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  corridorKm?: number;

  @ApiProperty({ required: false, enum: TripLeadFilter, default: TripLeadFilter.OPEN })
  @IsOptional()
  @IsEnum(TripLeadFilter)
  leadFilter?: TripLeadFilter;

  @ApiProperty({ required: false, default: false, description: 'Also show leads marked LOST (to win them back)' })
  @IsOptional()
  @IsBoolean()
  includeLost?: boolean;
}

/** POST /trips/optimise — the stops to put in the shortest driving order (first and last stay put). */
export class OptimiseStopsDto {
  @ApiProperty({ type: [TripStopDto] })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => TripStopDto)
  stops!: TripStopDto[];
}

export class TripLeadsDto {
  @ApiProperty({ type: [String], description: 'City ids, in the order to list them' })
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  cityIds!: string[];

  @ApiProperty({ required: false, enum: TripLeadFilter, default: TripLeadFilter.OPEN })
  @IsOptional()
  @IsEnum(TripLeadFilter)
  leadFilter?: TripLeadFilter;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  includeLost?: boolean;
}

export class CreateTripDto extends PlanTripDto {
  @ApiProperty({ example: 'Indore → Jabalpur, Friday' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiProperty({ required: false, example: '2026-10-24' })
  @IsOptional()
  @IsDateString()
  tripDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({ type: [String], description: 'The picked cities, in route order' })
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  cityIds!: string[];
}

export class UpdateTripDto extends PartialType(CreateTripDto) {
  @ApiProperty({ required: false, enum: TripStatus })
  @IsOptional()
  @IsEnum(TripStatus)
  status?: TripStatus;
}

export class ShareTripDto {
  @ApiProperty({ type: [String], description: 'Everyone the trip is shared with (replaces the list)' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  userIds!: string[];
}

export class TripTasksDto {
  @ApiProperty({ required: false, description: 'Who gets the visit tasks — the planner or someone it is shared with (default: you)' })
  @IsOptional()
  @IsUUID('4')
  userId?: string;
}

export class UpdateCityDto {
  @ApiProperty({ required: false, example: 'Dewas' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiProperty({ required: false, example: 22.9623 })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiProperty({ required: false, example: 76.0508 })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;
}
