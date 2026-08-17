import {
    Controller,
    Get,
    Patch,
    Post,
    Delete,
    Body,
    Query,
    Param,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from './users.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserFilterDto } from './dto/user-filter.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { broadcastAfter, type BroadcastEventType } from '../../common/realtime/broadcast-after';

@ApiTags('Users')
@Controller('users')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@ApiBearerAuth('JWT')
export class UsersController {
    constructor(
        private readonly usersService: UsersService,
        private readonly realtimeGateway: RealtimeGateway,
    ) { }

    /**
     * `id` é uuid aqui, não inteiro — a lista de usuários do admin o compara
     * como texto.
     *
     * `remove` é exclusão lógica (marca o e-mail com o sufixo de excluído), por
     * isso sai como `UPDATE` e não como `DELETE`.
     */
    private comBroadcast<T extends { id: string }>(
        eventType: BroadcastEventType,
        operacao: Promise<T>,
    ): Promise<T> {
        return broadcastAfter(this.realtimeGateway, 'usuarios', eventType, operacao, (u) => ({
            id: u.id,
        }));
    }

    @Get()
    @Roles('admin')
    @ApiOperation({ summary: 'Listar usuários (filtros: search, role, ativo)' })
    @ApiResponse({ status: 200, description: 'Lista de usuários' })
    async findAll(@Query() filter: UserFilterDto) {
        const { skip, take, ...filterRest } = filter;
        return this.usersService.findAll(filterRest, skip ?? 0, take ?? 10);
    }

    @Get(':id')
    @Roles('admin')
    @ApiOperation({ summary: 'Detalhes do usuário' })
    @ApiResponse({ status: 200, description: 'Usuário encontrado' })
    @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
    async findOne(@Param('id') id: string) {
        return this.usersService.findOne(id);
    }

    @Patch(':id')
    @Roles('admin')
    @ApiOperation({ summary: 'Atualizar dados do usuário (inclui role, ativo)' })
    @ApiResponse({ status: 200, description: 'Usuário atualizado' })
    @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
    async update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
        return this.comBroadcast('UPDATE', this.usersService.update(id, dto));
    }

    @Post(':id/activate')
    @Roles('admin')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Ativar usuário' })
    @ApiResponse({ status: 200, description: 'Usuário ativado' })
    async activate(@Param('id') id: string) {
        return this.comBroadcast('UPDATE', this.usersService.activate(id));
    }

    @Post(':id/deactivate')
    @Roles('admin')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Desativar usuário' })
    @ApiResponse({ status: 200, description: 'Usuário desativado' })
    @ApiResponse({ status: 403, description: 'Não é possível desativar a própria conta' })
    async deactivate(@Param('id') id: string, @CurrentUser('id') currentUserId: string) {
        return this.comBroadcast('UPDATE', this.usersService.deactivate(id, currentUserId));
    }

    @Delete(':id')
    @Roles('admin')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Excluir usuário permanentemente' })
    @ApiResponse({ status: 204, description: 'Usuário excluído' })
    @ApiResponse({ status: 403, description: 'Não é possível excluir a própria conta' })
    async remove(@Param('id') id: string, @CurrentUser('id') currentUserId: string) {
        // `remove` não devolve nada — o id vem da rota. É exclusão lógica
        // (marca o e-mail com o sufixo de excluído), daí `UPDATE`.
        return broadcastAfter(
            this.realtimeGateway,
            'usuarios',
            'UPDATE',
            this.usersService.remove(id, currentUserId),
            () => ({ id }),
        );
    }
}
