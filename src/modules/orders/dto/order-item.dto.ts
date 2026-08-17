import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsNotEmpty, Min } from 'class-validator';

export class OrderItemDto {
  @ApiProperty({ example: 1, description: 'ID do produto' })
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  produtoId: number;

  @ApiProperty({
    example: 1,
    description: 'ID da variedade do produto',
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  variedadeId?: number;

  @ApiProperty({ example: 2, description: 'Quantidade do item' })
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantidade: number;

  @ApiProperty({
    example: 25.0,
    description: 'Preço unitário do item',
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  precoUnitario?: number;
}
