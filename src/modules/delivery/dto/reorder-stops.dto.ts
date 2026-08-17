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
  @Type(() => Number)
  @IsInt()
  orderId?: number | null;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  orderIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  courierId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @Sanitized('plain', 32)
  @IsString()
  arrivalTime?: string;

  /** Segundos de parada após chegada (p.ex. ponto especial); usado ao recalcular horários após reorder. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  serviceStopSeconds?: number;

  @IsOptional()
  @Sanitized('plain', 32)
  @IsString()
  routeDepartureTime?: string;
}

export class ReorderStopsDto {
  /** Aceita legado onde um item pode ser só string (endereço). */
  @Transform(({ value }: { value: unknown }) => {
    if (!Array.isArray(value)) return value;
    return (value as unknown[]).map((item: unknown) =>
      typeof item === 'string' ? { address: item } : item,
    );
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RotaParadaDto)
  nomesParadas: RotaParadaDto[];
}
