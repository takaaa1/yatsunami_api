import { IsNumber, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { I18nStringDto } from '../../../common/dto/i18n-string.dto';

export class CreateCategoryDto {
    @ApiProperty({ type: I18nStringDto })
    @ValidateNested()
    @Type(() => I18nStringDto)
    nome: I18nStringDto;

    @ApiProperty({ example: 1, required: false })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    ordem?: number;
}
