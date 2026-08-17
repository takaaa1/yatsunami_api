import { IsArray, IsDateString, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

class CreateExpressOrderItemDto {
  @Type(() => Number)
  @IsInt()
  produtoId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  variedadeId?: number;

  @Type(() => Number)
  @IsInt()
  quantidade: number;
}

export class CreateExpressOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateExpressOrderItemDto)
  itens: CreateExpressOrderItemDto[];

  @IsOptional()
  @Sanitized('multiline')
  @IsString()
  observacoes?: string;

  @IsOptional()
  @IsDateString()
  dataEntrega?: string;
}
