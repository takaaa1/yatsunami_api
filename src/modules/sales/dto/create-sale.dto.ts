import { IsNotEmpty, IsNumber, IsOptional, IsString, IsArray, ValidateNested, IsEnum, IsDate } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export enum DiscountType {
    FIXED = 'fixed',
    PERCENTAGE = 'percentage',
}

export class CreateSaleItemDto {
    @ApiProperty()
    @Type(() => Number)
    @IsNumber()
    @IsNotEmpty()
    produtoId: number;

    @ApiProperty()
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    variedadeId?: number;

    @ApiProperty()
    @Type(() => Number)
    @IsNumber()
    @IsNotEmpty()
    quantidade: number;

    @ApiProperty()
    @Type(() => Number)
    @IsNumber()
    @IsNotEmpty()
    precoUnitario: number;

    @ApiProperty({ required: false, enum: DiscountType })
    @IsOptional()
    @IsEnum(DiscountType)
    tipoDesconto?: DiscountType;

    @ApiProperty({ required: false })
    @IsOptional()
    @Type(() => Number)
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
    @Type(() => Number)
    @IsNumber()
    descontoGeralValor?: number;

    @ApiProperty({ required: false, description: 'Delivery fee to add to the sale total' })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    taxaEntrega?: number;

    @ApiProperty({ required: false, description: 'Override sale date (defaults to now)' })
    @IsOptional()
    @IsDate()
    @Type(() => Date)
    data?: Date;

    @ApiProperty({ type: [CreateSaleItemDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreateSaleItemDto)
    itens: CreateSaleItemDto[];
}
