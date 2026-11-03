import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { IsLuhnValid, Sanitize } from '../../../../common/validation/decorators';

/** Dados de cartão em claro — trafegam somente em memória até a adquirente; nunca persistidos/logados. */
export class TokenizeCardDto {
  @Matches(/^\d{13,19}$/, { message: 'number deve conter de 13 a 19 dígitos' })
  @IsLuhnValid({ message: 'number inválido' })
  number!: string;

  @IsString() @Sanitize() @Length(2, 26) @Matches(/^[A-Za-z .'-]+$/, { message: 'holderName deve conter apenas letras sem acento' })
  holderName!: string;

  @IsInt() @Min(1) @Max(12)
  expMonth!: number;

  @IsInt() @Min(2000) @Max(2100)
  expYear!: number;

  @Matches(/^\d{3,4}$/, { message: 'cvv inválido' })
  cvv!: string;

  @IsOptional() @IsUUID()
  convenioId?: string;
}
