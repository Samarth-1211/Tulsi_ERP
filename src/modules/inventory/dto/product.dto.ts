import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export const PRODUCT_CATEGORIES = ['PLYWOOD', 'LAMINATE', 'BLOCKBOARD', 'MDF', 'HDHMR', 'VENEER', 'DOOR', 'HARDWARE', 'OTHER'] as const;
export const PRODUCT_UNITS = ['SHEET', 'PIECE', 'BOX', 'SQFT', 'KG'] as const;
export const STOCK_REASONS = ['RECEIVED', 'SOLD', 'RETURNED', 'DAMAGED', 'CORRECTION'] as const;

export class CreateProductDto {
  @ApiProperty({ example: 'Century Club Prime BWP 18mm' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ required: false, example: 'CEN-BWP-18' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  sku?: string;

  @ApiProperty({ required: false, enum: PRODUCT_CATEGORIES, default: 'PLYWOOD' })
  @IsOptional()
  @IsIn(PRODUCT_CATEGORIES)
  category?: string;

  @ApiProperty({ required: false, example: 'Century' }) @IsOptional() @IsString() @MaxLength(80) brand?: string;
  @ApiProperty({ required: false, example: 'BWP' }) @IsOptional() @IsString() @MaxLength(40) grade?: string;
  @ApiProperty({ required: false, example: '18mm' }) @IsOptional() @IsString() @MaxLength(20) thickness?: string;
  @ApiProperty({ required: false, example: '8x4 ft' }) @IsOptional() @IsString() @MaxLength(30) size?: string;

  @ApiProperty({ required: false, enum: PRODUCT_UNITS, default: 'SHEET' })
  @IsOptional()
  @IsIn(PRODUCT_UNITS)
  unit?: string;

  @ApiProperty({ required: false, example: 3650, description: 'Selling price per unit (₹)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiProperty({ required: false, example: 3100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice?: number;

  @ApiProperty({ required: false, example: 120, description: 'Opening stock' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock?: number;

  @ApiProperty({ required: false, example: 20, description: 'Low-stock alert at or below this quantity' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reorderLevel?: number;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

/** PATCH /inventory/products/:id — stock is changed only through the stock endpoint. */
export class UpdateProductDto extends PartialType(CreateProductDto) {
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() isActive?: boolean;
}

export class AdjustStockDto {
  @ApiProperty({ example: 50, description: 'Positive to add stock, negative to remove' })
  @Type(() => Number)
  @IsInt()
  change!: number;

  @ApiProperty({ enum: STOCK_REASONS, example: 'RECEIVED' })
  @IsIn(STOCK_REASONS)
  reason!: string;

  @ApiProperty({ required: false, example: 'Truck from Century depot' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class ProductQueryDto {
  @ApiProperty({ required: false, description: 'Name, SKU or brand contains; name/brand also match across Hindi/English spellings' }) @IsOptional() @IsString() search?: string;
  @ApiProperty({ required: false, enum: PRODUCT_CATEGORIES }) @IsOptional() @IsIn(PRODUCT_CATEGORIES) category?: string;
  @ApiProperty({ required: false, description: '"true" = only products at or below their reorder level' })
  @IsOptional()
  @IsIn(['true', 'false'])
  lowStock?: string;
  @ApiProperty({ required: false, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @ApiProperty({ required: false, default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number = 50;
}

export class DeleteProductDto {
  @ApiProperty({ example: 'delete' })
  @IsString()
  @Matches(/^delete$/i, { message: 'Type "delete" to confirm this deletion.' })
  confirmation!: string;
}
