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
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminKeyGuard } from '../auth/admin-key.guard';
import { BarberOrAdminGuard } from '../auth/barber-or-admin.guard';
import { BookingService } from './booking.service';
import { SlotsQueryDto } from './dto/slots-query.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BlockSlotDto } from './dto/block-slot.dto';

@ApiTags('bookings')
@Controller('bookings')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Get('services')
  @ApiOperation({ summary: 'List services' })
  listServices() {
    return this.bookingService.listServices();
  }

  @Get('slots')
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiOperation({ summary: 'Get 30-min slots for a day in Asia/Tashkent' })
  getSlots(@Query() query: SlotsQueryDto) {
    return this.bookingService.getSlots(query.date);
  }

  @Get('day-overview')
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiOperation({ summary: 'Mini App day overview (alias of slots)' })
  getDayOverview(@Query() query: SlotsQueryDto) {
    return this.bookingService.getSlots(query.date);
  }

  @Post()
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiOperation({ summary: 'Create a client booking' })
  createBooking(@Body() dto: CreateBookingDto) {
    return this.bookingService.createBooking(dto);
  }

  @Patch(':id/cancel')
  @UseGuards(BarberOrAdminGuard)
  @ApiOperation({ summary: 'Cancel a booking (authorized barber/admin only)' })
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  cancelBooking(@Param('id', ParseIntPipe) id: number) {
    return this.bookingService.cancelBooking(id, {
      allowPrivileged: true,
    });
  }

  @Post('block')
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiOperation({
    summary: 'Block a slot (barber via initData or admin key fallback)',
  })
  blockSlot(@Body() dto: BlockSlotDto) {
    return this.bookingService.blockSlot(dto);
  }

  @Delete('block/:id')
  @UseGuards(BarberOrAdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: false })
  @ApiHeader({ name: 'x-telegram-init-data', required: false })
  @ApiOperation({
    summary:
      'Unblock a barber-blocked slot (barber via initData or admin key fallback)',
  })
  unblockSlot(@Param('id', ParseIntPipe) id: number) {
    return this.bookingService.unblockSlot(id);
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
