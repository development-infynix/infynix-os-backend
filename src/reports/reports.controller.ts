import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { CurrentActor } from '../tenancy/actor.resolver.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { ReportsPolicy } from './reports.policy.js';
import { ReportsService } from './reports.service.js';
import { CreateReportDto } from './dto/create-report.dto.js';
import { UpdateReportDto } from './dto/update-report.dto.js';
import { UpdateReportRemarksDto } from './dto/update-report-remarks.dto.js';
import { UpdateReportSettingsDto } from './dto/update-report-settings.dto.js';

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
    const parsedPage = page === undefined ? 1 : Number(page);
    const parsedLimit = limit === undefined ? 100 : Number(limit);
    return this.reports.list(actor, parsedPage, parsedLimit, date, userId);
  }

  @Get('settings')
  @Can(ReportsPolicy, 'use')
  getSettings(@CurrentActor() actor: Actor) {
    return this.reports.getSettings(actor);
  }

  @Patch('settings')
  @Can(ReportsPolicy, 'use')
  updateSettings(@CurrentActor() actor: Actor, @Body() dto: UpdateReportSettingsDto) {
    return this.reports.updateSettings(dto, actor);
  }

  @Get(':id')
  @Can(ReportsPolicy, 'use')
  findOne(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.findOne(id, actor);
  }

  @Post()
  @Can(ReportsPolicy, 'use')
  create(@CurrentActor() actor: Actor, @Body() dto: CreateReportDto) {
    return this.reports.create(dto, actor);
  }

  @Patch(':id')
  @Can(ReportsPolicy, 'use')
  update(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReportDto) {
    return this.reports.update(id, dto, actor);
  }

  @Patch(':id/remarks')
  @Can(ReportsPolicy, 'use')
  updateRemarks(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReportRemarksDto) {
    return this.reports.updateRemarks(id, dto.remarks, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @Can(ReportsPolicy, 'use')
  async remove(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    await this.reports.remove(id, actor);
  }
}
