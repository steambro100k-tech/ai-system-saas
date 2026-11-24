import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminKeyGuard } from '../auth/admin-key.guard';
import { BarberOrAdminGuard } from '../auth/barber-or-admin.guard';
import { BookingService } from './booking.service';
import { BookingReminderService } from './booking-reminder.service';
import { SlotsQueryDto } from './dto/slots-query.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BlockSlotDto } from './dto/block-slot.dto';
import { Request } from 'express';

@ApiTags('bookings')
@Controller('bookings')
export class BookingController {
  constructor(
    private readonly bookingService: BookingService,
    private readonly bookingReminders: BookingReminderService,
  ) {}

  @Get('services')
  @ApiOperation({ summary: 'List services' })
  listServices() {
    return this.bookingService.listServices();
  }

  @Get('barbers')
  @ApiOperation({ summary: 'List active barbers' })
  listBarbers() {
    return this.bookingService.listBarbers();
  }

  @Get('slots')
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiQuery({ name: 'barberId', required: false, type: Number })
  @ApiOperation({ summary: 'Get 30-min slots for a barber or aggregate availability; each slot includes barber id/name and freeBarberIds' })
  getSlots(@Query() query: SlotsQueryDto, @Req() req: Request & { authActor?: any }) {
    const barberId = req.authActor?.type === 'barber' ? req.authActor.barberId : query.barberId;
    return this.bookingService.getSlots(query.date, barberId);
  }

  @Get('day-overview')
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiQuery({ name: 'barberId', required: false, type: Number })
  @ApiOperation({ summary: 'Mini App day overview with barber id/name on slots and bookings' })
  getDayOverview(@Query() query: SlotsQueryDto, @Req() req: Request & { authActor?: any }) {
    const barberId = req.authActor?.type === 'barber' ? req.authActor.barberId : query.barberId;
    return this.bookingService.getSlots(query.date, barberId);
  }

  @Post()
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiOperation({ summary: 'Create a client booking' })
  createBooking(@Body() dto: CreateBookingDto, @Req() req: Request & { authActor?: any }) {
    return this.bookingService.createBooking({
      ...dto,
      barberId: req.authActor?.type === 'barber' ? req.authActor.barberId : dto.barberId,
    });
  }

  @Post(':id/send-reminder')
  @UseGuards(AdminKeyGuard)
  @ApiHeader({ name: 'x-admin-key', required: true })
  @ApiOperation({ summary: 'Send a client booking reminder immediately (admin only)' })
  sendReminder(@Param('id', ParseIntPipe) id: number) {
    return this.bookingReminders.sendImmediately(id);
  }

  @Patch(':id/cancel')
  @UseGuards(BarberOrAdminGuard)
  @ApiOperation({ summary: 'Cancel a booking; response includes assigned barber id and name (authorized barber/admin only)' })
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  cancelBooking(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { authActor?: any }) {
    return this.bookingService.cancelBooking(id, {
      allowPrivileged: req.authActor?.type !== 'barber',
      barberId: req.authActor?.type === 'barber' ? req.authActor.barberId : undefined,
    });
  }

  @Post('block')
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiOperation({
    summary: 'Block a slot (barber via initData or admin key fallback)',
  })
  blockSlot(@Body() dto: BlockSlotDto, @Req() req: Request & { authActor?: any }) {
    const actor = req.authActor;
    return this.bookingService.blockSlot(dto, {
      barberId: actor?.barberId,
      isAdmin: actor?.type !== 'barber',
    });
  }

  @Delete('block/:id')
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiQuery({ name: 'barberId', required: true, type: Number })
  @ApiOperation({
    summary:
      'Unblock a barber-blocked slot (barber via initData or admin key fallback)',
  })
  unblockSlot(@Param('id', ParseIntPipe) id: number, @Query('barberId', ParseIntPipe) barberId: number, @Req() req: Request & { authActor?: any }) {
    const actor = req.authActor;
    return this.bookingService.unblockSlot(id, barberId, {
      barberId: actor?.barberId,
      isAdmin: actor?.type !== 'barber',
    });
  }

  @Post('seed')
  @UseGuards(AdminKeyGuard)
  @ApiHeader({ name: 'x-admin-key', required: true })
  @ApiOperation({
    summary: 'Create or update demo services (disabled in production)',
  })
  seed() {
    return this.bookingService.seedDemo();
  }

  @Delete('reset-demo')
  @UseGuards(AdminKeyGuard)
  @ApiHeader({ name: 'x-admin-key', required: true })
  @ApiOperation({ summary: 'Reset demo data (disabled in production)' })
  resetDemo() {
    return this.bookingService.resetDemo();
  }
}
