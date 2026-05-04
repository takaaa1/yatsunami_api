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
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @Sanitized('plain')
  @IsString()
  name: string;

  @IsOptional()
  @IsInt()
  orderId?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  orderIds?: number[];

  /**
   * Tempo de serviço na parada após chegada (segundos).
   * Enviado pelo cliente: 300 por defeito; pontos especiais = 300 × número de encomendas no ponto.
   */
  @IsOptional()
  @IsInt()
  serviceStopSeconds?: number;

  @IsOptional()
  @Sanitized('plain', 32)
  @IsString()
  routeDepartureTime?: string;
}

export class CreateRouteDto {
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
  @IsNumber()
  couriers?: number;

  @IsOptional()
  @IsBoolean()
  includeSpecialAddresses?: boolean;
}
