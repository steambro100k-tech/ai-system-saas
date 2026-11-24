import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

export class CreateBookingDto {
  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  serviceId!: number;

  @ApiProperty({
    example: '2026-11-24T05:00:00.000Z',
    description: 'Start time as ISO datetime (UTC instant)',
  })
  @IsISO8601()
  startTimeIso!: string;

  @ApiPropertyOptional({ example: 10, minimum: 0, maximum: 15 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @ApiProperty({
    example: '123456789',
    description: 'Telegram numeric user ID',
  })
  @IsString()
  @Matches(/^\d{1,20}$/)
  clientTelegramId!: string;

  @ApiPropertyOptional({ example: 'Ali' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientName?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  clientPhone?: string;
}
