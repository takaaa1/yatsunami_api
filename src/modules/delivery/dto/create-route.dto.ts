import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class CreateRouteDestinationDto {
  @Sanitized('plain')
  @IsString()
  address: string;

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
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  longitude?: number;

  @Sanitized('plain')
  @IsString()
  name: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  orderId?: number;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  orderIds?: number[];

  /**
   * Tempo de serviço na parada após chegada (segundos).
   * Enviado pelo cliente: 300 por defeito; pontos especiais = 300 × número de encomendas no ponto.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  serviceStopSeconds?: number;

  @IsOptional()
  @Sanitized('plain', 32)
  @IsString()
  routeDepartureTime?: string;

  @IsOptional()
  @Sanitized('plain', 128)
  @IsString()
  specialPointName?: string;
}

export class CreateRouteDto {
  @Type(() => Number)
  @IsNumber()
  formId: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateRouteDestinationDto)
  destinations: CreateRouteDestinationDto[];

  @IsOptional()
  @Sanitized('plain')
  @IsString()
  origin?: string;

  @IsOptional()
  @Sanitized('plain', 32)
  @IsString()
  departureTime?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  couriers?: number;

  @IsOptional()
  @IsBoolean()
  includeSpecialAddresses?: boolean;
}
