import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { broadcastAfter, type BroadcastEventType } from '../../common/realtime/broadcast-after';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /** Categoria agrupa o cardápio e o PDV; a ordem também é exibida. */
  private comBroadcast<T extends { id: number }>(
    eventType: BroadcastEventType,
    operacao: Promise<T>,
  ): Promise<T> {
    return broadcastAfter(this.realtimeGateway, 'categorias', eventType, operacao, (c) => ({
      id: c.id,
    }));
  }

  @Post()
  @ApiBearerAuth('JWT')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Create a new category' })
  create(@Body() createCategoryDto: CreateCategoryDto) {
    return this.comBroadcast('INSERT', this.categoriesService.create(createCategoryDto));
  }

  @Get()
  @ApiOperation({ summary: 'List all categories' })
  findAll() {
    return this.categoriesService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a category by ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.categoriesService.findOne(id);
  }

  @Patch(':id')
  @ApiBearerAuth('JWT')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Update a category' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateCategoryDto: UpdateCategoryDto,
  ) {
    return this.comBroadcast('UPDATE', this.categoriesService.update(id, updateCategoryDto));
  }

  @Delete(':id')
  @ApiBearerAuth('JWT')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Delete a category' })
  remove(@Param('id', ParseIntPipe) id: number) {
    // `remove` devolve `{ deleted }`, sem o id — ele vem da rota.
    return broadcastAfter(
      this.realtimeGateway,
      'categorias',
      'DELETE',
      this.categoriesService.remove(id),
      () => ({ id }),
    );
  }
}
