import { IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { IsBrazilianDocument, NormalizeDocument, Sanitize } from '../../../common/validation/decorators';

export class CreateMerchantDto {
  @IsString()
  @Sanitize()
  @Length(2, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Sanitize()
  @Length(2, 120)
  tradeName?: string;

  @NormalizeDocument()
  @IsBrazilianDocument()
  document!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;
}
