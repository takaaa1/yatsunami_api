import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { IsArray, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProductDto } from './create-product.dto';
import { UpdateVariedadeDto } from './variedade.dto';

export class UpdateProductDto extends PartialType(
  OmitType(CreateProductDto, ['variedades'] as const),
) {
  /**
   * Variedades **com** `id`: a edição atualiza cada uma no lugar. Sem o `id`
   * (variedade nova, ou build antigo do app), o serviço casa pelo nome.
   */
  @ApiProperty({ type: [UpdateVariedadeDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateVariedadeDto)
  variedades?: UpdateVariedadeDto[];
}
