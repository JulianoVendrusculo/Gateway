import { Global, Module } from '@nestjs/common';
import { BankHttpClientFactory } from './bank-http-client.factory';

@Global()
@Module({
  providers: [BankHttpClientFactory],
  exports: [BankHttpClientFactory],
})
export class HttpModule {}
