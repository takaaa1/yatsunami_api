import { IsArray, IsDateString, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

class CreateExpressOrderItemDto {
  @IsInt()
  produtoId: number;

  @IsOptional()
  @IsInt()
  variedadeId?: number;

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
