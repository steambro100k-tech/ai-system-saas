import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class BlockSlotDto {
  @ApiProperty({ example: '2026-11-24T05:00:00.000Z' })
  @IsISO8601()
  startTimeIso!: string;

  @ApiPropertyOptional({
    example: 30,
    description: 'Duration in minutes, multiple of 30. Defaults to 30.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  durationMin?: number;

  @ApiPropertyOptional({ example: 'Lunch break' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  note?: string;
}
