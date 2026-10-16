import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { AssignLeadDto } from './assign-lead.dto';
import { MAX_BULK_LEADS } from './bulk-delete-leads.dto';

export class BulkAssignLeadsDto extends AssignLeadDto {
  @ApiProperty({ type: [String], description: 'Ids of the leads to hand to `toUserId`' })
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one lead' })
  @ArrayMaxSize(MAX_BULK_LEADS)
  @IsUUID('all', { each: true })
  leadIds!: string[];
}
