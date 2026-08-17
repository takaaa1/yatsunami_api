import { Controller, Get, Patch, Delete, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('notifications')
@ApiBearerAuth('JWT')
@UseGuards(AuthGuard('jwt'))
@Controller('notifications')
export class NotificationsController {
    constructor(private readonly notificationsService: NotificationsService) { }

    @Get()
    @ApiOperation({ summary: 'List notifications for the current user' })
    findAll(
        @CurrentUser('id') userId: string,
        @Query('skip', new ParseIntPipe({ optional: true })) skip?: number,
        @Query('take', new ParseIntPipe({ optional: true })) take?: number,
    ) {
        return this.notificationsService.getUserNotifications(userId, Number(skip) || 0, Number(take) || 10);
    }

    @Patch('read-all')
    @ApiOperation({ summary: 'Mark all notifications as read' })
    readAll(@CurrentUser('id') userId: string) {
        return this.notificationsService.markAllAsRead(userId);
    }

    @Patch(':id/read')
    @ApiOperation({ summary: 'Mark a notification as read' })
    read(@Param('id') id: string, @CurrentUser('id') userId: string) {
        return this.notificationsService.markAsRead(id, userId);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a notification' })
    deleteOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
        return this.notificationsService.deleteOne(id, userId);
    }
}
