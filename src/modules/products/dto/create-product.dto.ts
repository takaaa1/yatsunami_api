import { IsString, IsNumber, IsOptional, IsBoolean, IsUrl, Min, ValidateNested, IsArray, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { I18nStringDto } from '../../../common/dto/i18n-string.dto';
import { CreateVariedadeDto } from './variedade.dto';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class CreateProductDto {
    @ApiProperty({ type: I18nStringDto })
    @ValidateNested()
    @Type(() => I18nStringDto)
    nome: I18nStringDto;

    @ApiProperty({ example: 45.00, required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    preco?: number;

    @ApiProperty({ type: I18nStringDto, required: false })
    @IsOptional()
    @ValidateNested()
    @Type(() => I18nStringDto)
    ingredientes?: I18nStringDto;

    @ApiProperty({ example: 1, required: false, default: 1 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    quantidade?: number;

    @ApiProperty({ type: I18nStringDto })
    @ValidateNested()
    @Type(() => I18nStringDto)
    categoria: I18nStringDto;

    @ApiProperty({ type: I18nStringDto, required: false })
    @IsOptional()
    @ValidateNested()
    @Type(() => I18nStringDto)
    observacoes?: I18nStringDto;

    @ApiProperty({ required: false })
    @IsOptional()
    @Sanitized('plain', 2048)
    @IsString()
    @ValidateIf((o) => o.imagem !== '' && o.imagem !== null && o.imagem !== undefined)
    @IsUrl()
    imagem?: string;

    @ApiProperty({ example: 'YAKI', required: false })
    @IsOptional()
    @Sanitized('plain', 32)
    @IsString()
    abreviacao?: string;

    @ApiProperty({ default: true, required: false })
    @IsOptional()
    @IsBoolean()
    ativo?: boolean;

    @ApiProperty({ type: [CreateVariedadeDto], required: false })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreateVariedadeDto)
    variedades?: CreateVariedadeDto[];
}
