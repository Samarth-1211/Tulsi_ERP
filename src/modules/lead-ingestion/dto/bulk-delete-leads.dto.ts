import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { DeleteLeadDto } from './delete-lead.dto';

/** Room for a whole uploaded sheet (MAX_IMPORT_ROWS) and then some. */
export const MAX_BULK_LEADS = 10000;

export class BulkDeleteLeadsDto extends DeleteLeadDto {
  @ApiProperty({ type: [String], description: 'Ids of the leads to delete permanently' })
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one lead' })
  @ArrayMaxSize(MAX_BULK_LEADS)
  @IsUUID('all', { each: true })
  leadIds!: string[];
}
