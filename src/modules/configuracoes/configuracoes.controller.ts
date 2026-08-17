import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfiguracoesService } from './configuracoes.service';
import { UpdateConfiguracaoDto } from './dto/update-configuracao.dto';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { broadcastAfter, type BroadcastEventType } from '../../common/realtime/broadcast-after';

@ApiTags('Configuracoes')
@Controller('configuracoes')
@ApiBearerAuth('JWT')
export class ConfiguracoesController {
    constructor(
        private readonly configuracoesService: ConfiguracoesService,
        private readonly realtimeGateway: RealtimeGateway,
    ) { }

    @Get()
    @ApiOperation({ summary: 'Busca as configurações globais' })
    async getConfig() {
        return this.configuracoesService.get();
    }

    @Patch()
    @Roles('admin')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @ApiOperation({ summary: 'Atualiza as configurações globais' })
    async updateConfig(@Body() body: UpdateConfiguracaoDto) {
        // Muda a taxa de entrega e os pontos de entrega comum — o carrinho do
        // cliente calcula com esses valores. A linha é única (`id` = 1), então
        // o evento não precisa identificar registro.
        return broadcastAfter(
            this.realtimeGateway,
            'configuracao_formularios',
            'UPDATE',
            this.configuracoesService.update(body),
            () => ({ id: 1 }),
        );
    }
}
