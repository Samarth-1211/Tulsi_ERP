import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class AssignManagerDto {
  @ApiProperty({ example: '9780b5d3-d5c8-451a-b060-8cc0e4665588' })
  @IsNotEmpty()
  @IsUUID()
  managerId!: string;
}
