import { IsString, IsOptional, IsEnum, IsNumber, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export enum TipoChavePix {
    CPF = 'cpf',
    CNPJ = 'cnpj',
    EMAIL = 'email',
    PHONE = 'phone',
    EVP = 'evp',
    RANDOM = 'random',
}

export class UpdateConfiguracaoDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @Sanitized('plain', 128)
    @IsString()
    chavePix?: string;

    @ApiProperty({ required: false, enum: TipoChavePix })
    @IsOptional()
    @IsEnum(TipoChavePix)
    tipoChavePix?: TipoChavePix;

    @ApiProperty({ required: false })
    @IsOptional()
    @Sanitized('plain', 25)
    @IsString()
    @MaxLength(25)
    nomeRecebedor?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @Sanitized('plain', 15)
    @IsString()
    @MaxLength(15)
    cidadeRecebedor?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    taxaEntregaBase?: number;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    valorMinimoTaxaReduzida?: number;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    taxaEntregaReduzida?: number;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    valorMinimoIsencao?: number;

    @ApiProperty({ required: false })
    @IsOptional()
    enderecosEspeciais?: any;

    @ApiProperty({ required: false })
    @IsOptional()
    enderecoRestaurante?: any;
}
