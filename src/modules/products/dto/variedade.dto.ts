import { IsNumber, IsOptional, IsBoolean, Min, ValidateNested, IsString, IsUrl, ValidateIf, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { I18nStringDto } from '../../../common/dto/i18n-string.dto';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';
import { UnidadeMedida, TipoProduto } from '@prisma/client';

export class CreateVariedadeDto {
    @ApiProperty({ type: I18nStringDto })
    @ValidateNested()
    @Type(() => I18nStringDto)
    nome: I18nStringDto;

    @ApiProperty({ example: 10.00 })
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    preco: number;

    @ApiProperty({ type: I18nStringDto, required: false })
    @IsOptional()
    @ValidateNested()
    @Type(() => I18nStringDto)
    ingredientes?: I18nStringDto;

    @ApiProperty({ example: 1, required: false, default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(1)
    quantidade?: number;

    @ApiProperty({ enum: UnidadeMedida, required: false, default: UnidadeMedida.UN })
    @IsOptional()
    @IsEnum(UnidadeMedida)
    unidadeMedida?: UnidadeMedida;

    @ApiProperty({ enum: TipoProduto, required: false, default: TipoProduto.ITEM })
    @IsOptional()
    @IsEnum(TipoProduto)
    tipoProduto?: TipoProduto;

    @ApiProperty({ default: true, required: false })
    @IsOptional()
    @IsBoolean()
    ativo?: boolean;

    @ApiProperty({ required: false })
    @IsOptional()
    @Sanitized('plain', 2048)
    @IsString()
    @ValidateIf((o: { imagem?: string | null }) => o.imagem !== '' && o.imagem !== null && o.imagem !== undefined)
    @IsUrl()
    imagem?: string;
}

export class UpdateVariedadeDto extends CreateVariedadeDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    id?: number;
}
