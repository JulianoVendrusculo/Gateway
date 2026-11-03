import { Global, Module } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { ApiKeyGuard } from './api-key.guard';

@Global()
@Module({
  providers: [ApiKeyGuard, AdminGuard],
  exports: [ApiKeyGuard, AdminGuard],
})
export class AuthModule {}
