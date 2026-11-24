import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Matches, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SlotsQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-24',
    description: 'Date in YYYY-MM-DD (Asia/Tashkent)',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional({ example: 2, description: 'Filter slots for a specific barber; omit for aggregate availability' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  barberId?: number;
}
