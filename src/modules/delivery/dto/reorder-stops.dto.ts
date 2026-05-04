import { Type, Transform } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

/**
 * Item de parada na rota (espelha o JSON em nomesParadas).
 * Com ValidationPipe global (whitelist: true), cada campo precisa de decorador;
 * caso contrário o class-validator remove todas as chaves dos objetos do array.
 */
export class RotaParadaDto {
  @Sanitized('plain')
  @IsString()
  address: string;

  @IsOptional()
  @Sanitized('plain')
  @IsString()
  name?: string;

  @IsOptional()
  @Sanitized('plain')
  @IsString()
  fullAddress?: string;

  @IsOptional()
  @Sanitized('plain', 16)
  @IsString()
  cep?: string;

  @IsOptional()
  @IsInt()
  orderId?: number | null;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  orderIds?: number[];

  @IsOptional()
  @IsNumber()
  courierId?: number;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @Sanitized('plain', 32)
  @IsString()
  arrivalTime?: string;

  /** Segundos de parada após chegada (p.ex. ponto especial); usado ao recalcular horários após reorder. */
  @IsOptional()
  @IsInt()
  serviceStopSeconds?: number;

  @IsOptional()
  @Sanitized('plain', 32)
  @IsString()
  routeDepartureTime?: string;
}

export class ReorderStopsDto {
  /** Aceita legado onde um item pode ser só string (endereço). */
  @Transform(({ value }) => {
    if (!Array.isArray(value)) return value;
    return value.map((item: unknown) =>
      typeof item === 'string' ? { address: item } : item,
    );
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RotaParadaDto)
  nomesParadas: RotaParadaDto[];
}
