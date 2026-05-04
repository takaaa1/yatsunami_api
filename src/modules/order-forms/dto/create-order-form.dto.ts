import { IsBoolean, IsDateString, IsOptional, IsString, IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

class SelectionDto {
    @ApiProperty()
    @IsNumber()
    product_id: number;

    @ApiProperty({ required: false })
    @IsNumber()
    @IsOptional()
    variedade_id?: number | null;
}

export class CreateOrderFormDto {
    @ApiProperty({ description: 'Data da entrega (YYYY-MM-DD)', example: '2024-12-25' })
    @IsDateString()
    data_entrega: string;

    @ApiProperty({ description: 'Data/hora de início para pedidos (ISO String)', example: '2024-12-20T09:00:00Z', required: false })
    @IsDateString()
    @IsOptional()
    data_inicio_pedido?: string;

    @ApiProperty({ description: 'Prazo limite para pedidos (ISO String)', example: '2024-12-24T23:59:00Z' })
    @IsDateString()
    data_limite_pedido: string;

    @ApiProperty({ description: 'Indica se o formulário está ativo', default: true })
    @IsBoolean()
    @IsOptional()
    ativo?: boolean;

    @ApiProperty({ description: 'Indica se a entrega foi concluída', default: false })
    @IsBoolean()
    @IsOptional()
    concluido?: boolean;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SelectionDto)
    @ApiProperty({ type: [SelectionDto], required: false })
    selections?: SelectionDto[];

    @ApiProperty({ description: 'Observações internas', required: false })
    @IsOptional()
    @Sanitized('multiline')
    @IsString()
    observacoes?: string;

    @ApiProperty({ description: 'Endereços especiais (JSON stringified)', required: false })
    @IsOptional()
    enderecos_especiais?: any;
}
