import { IsNotEmpty, IsNumber, IsOptional, IsString, IsArray, ValidateNested, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export enum DiscountType {
    FIXED = 'fixed',
    PERCENTAGE = 'percentage',
}

export class CreateSaleItemDto {
    @ApiProperty()
    @IsNumber()
    @IsNotEmpty()
    produtoId: number;

    @ApiProperty()
    @IsOptional()
    @IsNumber()
    variedadeId?: number;

    @ApiProperty()
    @IsNumber()
    @IsNotEmpty()
    quantidade: number;

    @ApiProperty()
    @IsNumber()
    @IsNotEmpty()
    precoUnitario: number;

    @ApiProperty({ required: false, enum: DiscountType })
    @IsOptional()
    @IsEnum(DiscountType)
    tipoDesconto?: DiscountType;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    valorDesconto?: number;
}

export class CreateSaleDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @Sanitized('plain', 64)
    @IsString()
    usuarioId?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @Sanitized('multiline')
    @IsString()
    observacoes?: string;

    @ApiProperty({ required: false, enum: DiscountType })
    @IsOptional()
    @IsEnum(DiscountType)
    descontoGeralTipo?: DiscountType;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    descontoGeralValor?: number;

    @ApiProperty({ required: false, description: 'Delivery fee to add to the sale total' })
    @IsOptional()
    @IsNumber()
    taxaEntrega?: number;

    @ApiProperty({ type: [CreateSaleItemDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreateSaleItemDto)
    itens: CreateSaleItemDto[];
}
