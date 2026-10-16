import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

// role and managerId are intentionally NOT editable here — role changes
// and re-parenting to a different manager are sensitive enough to warrant
// their own endpoint/audit trail rather than a generic PATCH field.
export class UpdateTeamMemberDto {
  @IsOptional()
  @IsString()
  name?: string;

  // null clears the stored number; omitting the field leaves it unchanged.
  @IsOptional()
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
