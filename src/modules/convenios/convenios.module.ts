import { Module } from '@nestjs/common';
import { GatewaysModule } from '../payments/gateways/gateways.module';
import { ConvenioVault } from './convenio-vault.service';
import { ConveniosController } from './convenios.controller';
import { ConveniosService } from './convenios.service';

@Module({
  imports: [GatewaysModule],
  controllers: [ConveniosController],
  providers: [ConvenioVault, ConveniosService],
  exports: [ConvenioVault, ConveniosService],
})
export class ConveniosModule {}
