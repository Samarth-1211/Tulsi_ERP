// Outward-facing team member shape. An `interface`, not a `class`: it only
// describes a return type and is never instantiated.
export interface TeamMemberResponseDto {
  id: string;
  orgId: string | null;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  managerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Present on create responses only: whether the invite email actually left
   * the server, and why not when it didn't. The member is created either way.
   */
  emailDelivery?: { sent: boolean; error?: string };
  [key: string]: unknown; // permits passing through any other User fields untouched
}
