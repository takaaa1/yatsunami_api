import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsArray, ValidateNested, IsNotEmpty, Min, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderItemDto } from './order-item.dto';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class CreateOrderDto {
    @ApiProperty({ example: 1, description: 'ID da data de encomenda' })
    @IsNotEmpty()
    @IsNumber()
    dataEncomendaId: number;

    @ApiProperty({ example: 2, description: 'Quantidade de talheres', default: 0 })
    @IsNumber()
    @Min(0)
    talheres: number = 0;

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

    @ApiProperty({ example: 10.00, description: 'Taxa de entrega', default: 0 })
    @IsOptional()
    @IsNumber()
    @Min(0)
    taxaEntrega?: number = 0;

    @ApiProperty({ example: 150.00, description: 'Valor total do pedido', required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    totalValor?: number;

    @ApiProperty({ example: 'Condomínio X', description: 'Nome do endereço especial', required: false })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    enderecoEspecialNome?: string;

    @ApiProperty({ example: true, description: 'Se precisa de talheres', default: false })
    @IsOptional()
    @IsBoolean()
    precisaTalheres?: boolean = false;

    @ApiProperty({ example: { street: 'Rua A' }, description: 'Endereço de entrega', required: false })
    @IsOptional()
    enderecoEntrega?: any;

    @ApiProperty({ type: [OrderItemDto], description: 'Itens do pedido' })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OrderItemDto)
    itens: OrderItemDto[];
}
