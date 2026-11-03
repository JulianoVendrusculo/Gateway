import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CreateMerchantDto } from './dto/create-merchant.dto';
import { MerchantsService } from './merchants.service';

@Controller('v1/admin/merchants')
@UseGuards(AdminGuard)
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  /** Retorna a API key UMA única vez. */
  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body() dto: CreateMerchantDto) {
    return this.merchants.create(dto);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.merchants.get(id);
  }

  @Post(':id/api-key/rotate')
  @Header('Cache-Control', 'no-store')
  rotate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.merchants.rotateApiKey(id);
  }
}
