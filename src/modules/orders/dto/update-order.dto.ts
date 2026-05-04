import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsArray, ValidateNested, Min, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderItemDto } from './order-item.dto';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class UpdateOrderDto {
    @ApiProperty({ example: 1, description: 'ID da data de encomenda', required: false })
    @IsOptional()
    @IsNumber()
    dataEncomendaId?: number;

    @ApiProperty({ example: 150.00, description: 'Valor total do pedido', required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    totalValor?: number;

    @ApiProperty({ example: 12.00, description: 'Taxa de entrega', required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    taxaEntrega?: number;

    @ApiProperty({ example: 2, description: 'Quantidade de talheres', required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    talheres?: number;

    @ApiProperty({ example: 'Sem cebola', description: 'Observações do pedido', required: false })
    @IsOptional()
    @Sanitized('multiline')
    @IsString()
    observacoes?: string;

    @ApiProperty({ example: 'pix', description: 'Forma de pagamento', required: false })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    formaPagamento?: string;

    @ApiProperty({ example: 'entrega', description: 'Tipo de entrega', required: false })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    tipoEntrega?: string;

    @ApiProperty({ example: 'Condomínio X', description: 'Nome do endereço especial', required: false })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    enderecoEspecialNome?: string;

    @ApiProperty({ example: true, description: 'Se precisa de talheres', required: false })
    @IsOptional()
    @IsBoolean()
    precisaTalheres?: boolean;

    @ApiProperty({ example: { street: 'Rua A' }, description: 'Endereço de entrega', required: false })
    @IsOptional()
    enderecoEntrega?: any;

    @ApiProperty({ type: [OrderItemDto], description: 'Itens do pedido', required: false })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OrderItemDto)
    itens?: OrderItemDto[];
}
