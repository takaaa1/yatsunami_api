import { IsNotEmpty, IsNumber, IsOptional, IsString, IsArray, ValidateNested, IsDateString, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class CreateExpenseItemDto {
    @ApiProperty()
    @Sanitized('multiline')
    @IsString()
    @IsNotEmpty()
    descricao: string;

    @ApiProperty()
    @IsNumber()
    @IsNotEmpty()
    quantidade: number;

    @ApiProperty()
    @IsNumber()
    @IsOptional()
    valorUnitario?: number;

    @ApiProperty()
    @IsNumber()
    @IsNotEmpty()
    valor: number;
}

export class CreateExpenseDto {
    @ApiProperty()
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    nomeEstabelecimento?: string;

    @ApiProperty()
    @IsDateString()
    @IsOptional()
    dataCompra?: string;

    @ApiProperty()
    @IsNumber()
    @IsNotEmpty()
    valorTotal: number;

    @ApiProperty()
    @IsNumber()
    @IsOptional()
    valorTotalSemDesconto?: number;

    @ApiProperty()
    @IsNumber()
    @IsOptional()
    valorDesconto?: number;

    @ApiProperty()
    @IsBoolean()
    @IsOptional()
    foiEditada?: boolean;

    @ApiProperty()
    @IsOptional()
    @Sanitized('plain', 2048)
    @IsString()
    urlQrcode?: string;

    @ApiProperty()
    @IsOptional()
    @Sanitized('multiline')
    @IsString()
    xmlRaw?: string;

    @ApiProperty({ type: [CreateExpenseItemDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreateExpenseItemDto)
    itens: CreateExpenseItemDto[];
}

export class ParseQrDto {
    @ApiProperty()
    @Sanitized('plain', 2048)
    @IsString()
    @IsNotEmpty()
    url: string;
}
