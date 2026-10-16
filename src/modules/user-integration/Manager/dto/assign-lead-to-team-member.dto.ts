import { IsUUID } from 'class-validator';

export class AssignLeadToTeamMemberDto {
  @IsUUID()
  userId!: string;
}
