import { Global, Module } from '@nestjs/common';
import { UserDeletionService } from './user-deletion.service';

@Global()
@Module({
  providers: [UserDeletionService],
  exports: [UserDeletionService],
})
export class UserDeletionModule {}
