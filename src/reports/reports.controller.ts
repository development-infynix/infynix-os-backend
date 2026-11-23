import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { CurrentActor } from '../tenancy/actor.resolver.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { ReportsPolicy } from './reports.policy.js';
import { ReportsService } from './reports.service.js';
import { CreateReportDto } from './dto/create-report.dto.js';
import { UpdateReportDto } from './dto/update-report.dto.js';
import { UpdateReportRemarksDto } from './dto/update-report-remarks.dto.js';
import { UpdateReportSettingsDto } from './dto/update-report-settings.dto.js';

const DEFAULT_PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positiveInt(
  value: string | undefined,
  fallback: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException(
      `${name} must be a whole number from 1 to ${max}.`,
    );
  }
  return parsed;
}

/** Daily work reports. Every route needs the `reports` menu (owners always have it). */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @Can(ReportsPolicy, 'use')
  list(
    @CurrentActor() actor: Actor,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('date') date?: string,
    @Query('userId') userId?: string,
  ) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new BadRequestException('Date must use the YYYY-MM-DD format.');
    if (userId && !UUID.test(userId))
      throw new BadRequestException('Invalid person id.');
    return this.reports.list(actor, {
      page: positiveInt(page, 1, 100_000, 'Page'),
      pageSize: positiveInt(limit, DEFAULT_PAGE_SIZE, 100, 'Limit'),
      date: date || undefined,
      userId: userId || undefined,
    });
  }

  // Fixed paths before ':id', so "settings" and "people" never parse as ids.
  @Get('settings')
  @Can(ReportsPolicy, 'use')
  getSettings(@CurrentActor() actor: Actor) {
    return this.reports.getSettings(actor);
  }

  @Patch('settings')
  @Can(ReportsPolicy, 'use')
  updateSettings(
    @CurrentActor() actor: Actor,
    @Body() dto: UpdateReportSettingsDto,
  ) {
    return this.reports.updateSettings(dto, actor);
  }

  /** Per-day counts for the month view: `from` and `to` are YYYY-MM-DD, at most 62 days apart. */
  @Get('calendar')
  @Can(ReportsPolicy, 'use')
  calendar(
    @CurrentActor() actor: Actor,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId') userId?: string,
  ) {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!from || !to || !day.test(from) || !day.test(to))
      throw new BadRequestException(
        'from and to must use the YYYY-MM-DD format.',
      );
    if (userId && !UUID.test(userId))
      throw new BadRequestException('Invalid person id.');
    return this.reports.calendar(actor, {
      from,
      to,
      userId: userId || undefined,
    });
  }

  @Get('people')
  @Can(ReportsPolicy, 'use')
  people(
    @CurrentActor() actor: Actor,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('selected') selected?: string,
  ) {
    if (selected && !UUID.test(selected))
      throw new BadRequestException('Invalid person id.');
    return this.reports.people(actor, {
      query: (q ?? '').trim().slice(0, 100),
      limit: positiveInt(limit, 20, 50, 'Limit'),
      selected: selected || undefined,
    });
  }

  @Get(':id')
  @Can(ReportsPolicy, 'use')
  findOne(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reports.findOne(id, actor);
  }

  @Post()
  @Can(ReportsPolicy, 'use')
  create(@CurrentActor() actor: Actor, @Body() dto: CreateReportDto) {
    return this.reports.create(dto, actor);
  }

  @Patch(':id')
  @Can(ReportsPolicy, 'use')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReportDto,
  ) {
    return this.reports.update(id, dto, actor);
  }

  @Patch(':id/remarks')
  @Can(ReportsPolicy, 'use')
  updateRemarks(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReportRemarksDto,
  ) {
    return this.reports.updateRemarks(id, dto.remarks, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @Can(ReportsPolicy, 'use')
  async remove(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.reports.remove(id, actor);
  }
}
