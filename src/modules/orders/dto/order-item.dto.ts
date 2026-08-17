import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsNotEmpty, Min } from 'class-validator';

export class OrderItemDto {
    @ApiProperty({ example: 1, description: 'ID do produto' })
    @IsNotEmpty()
    @IsNumber()
    produtoId: number;

    @ApiProperty({ example: 1, description: 'ID da variedade do produto', required: false })
    @IsOptional()
    @IsNumber()
    variedadeId?: number;

    @ApiProperty({ example: 2, description: 'Quantidade do item' })
    @IsNotEmpty()
    @IsNumber()
    @Min(1)
    quantidade: number;

    @ApiProperty({ example: 25.00, description: 'Preço unitário do item', required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    precoUnitario?: number;
}
