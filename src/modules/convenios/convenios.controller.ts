import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { ConveniosService } from './convenios.service';
import { CreateConvenioDto, RotateCredentialsDto, UpdateConvenioDto } from './dto/convenio.dto';

@Controller('v1/admin')
@UseGuards(AdminGuard)
export class ConveniosController {
  constructor(private readonly convenios: ConveniosService) {}

  @Post('merchants/:merchantId/convenios')
  create(@Param('merchantId', new ParseUUIDPipe()) merchantId: string, @Body() dto: CreateConvenioDto) {
    return this.convenios.create(merchantId, dto);
  }

  @Get('merchants/:merchantId/convenios')
  list(@Param('merchantId', new ParseUUIDPipe()) merchantId: string) {
    return this.convenios.list(merchantId);
  }

  @Get('convenios/:id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.convenios.get(id);
  }

  @Patch('convenios/:id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateConvenioDto) {
    return this.convenios.update(id, dto);
  }

  /** Rotação de credenciais/certificado (re-cifra com a chave ativa e invalida caches de token/mTLS). */
  @Put('convenios/:id/credentials')
  rotateCredentials(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RotateCredentialsDto) {
    return this.convenios.rotateCredentials(id, dto);
  }
}
