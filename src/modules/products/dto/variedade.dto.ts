import { IsNumber, IsOptional, IsBoolean, Min, ValidateNested, IsString, IsUrl, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { I18nStringDto } from '../../../common/dto/i18n-string.dto';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class CreateVariedadeDto {
    @ApiProperty({ type: I18nStringDto })
    @ValidateNested()
    @Type(() => I18nStringDto)
    nome: I18nStringDto;

    @ApiProperty({ example: 10.00 })
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
    @IsNumber()
    @Min(1)
    quantidade?: number;

    @ApiProperty({ default: true, required: false })
    @IsOptional()
    @IsBoolean()
    ativo?: boolean;

    @ApiProperty({ required: false })
    @IsOptional()
    @Sanitized('plain', 2048)
    @IsString()
    @ValidateIf((o) => o.imagem !== '' && o.imagem !== null && o.imagem !== undefined)
    @IsUrl()
    imagem?: string;
}

export class UpdateVariedadeDto extends CreateVariedadeDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    id?: number;
}
