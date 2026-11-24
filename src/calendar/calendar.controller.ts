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
import { CalendarPolicy } from './calendar.policy.js';
import { CalendarService } from './calendar.service.js';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto.js';
import { UpdateCalendarEventDto } from './dto/update-calendar-event.dto.js';

/**
 * Announcements and meetings (docs/calendar-plan.md). Every route needs the
 * `calendar` menu (owners always have it); per-event rules live in the service.
 */
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /** Events overlapping [from, to) the caller can see; ISO date-times, at most 62 days apart. */
  @Get()
  @Can(CalendarPolicy, 'use')
  list(
    @CurrentActor() actor: Actor,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!from || !to)
      throw new BadRequestException('from and to are required.');
    return this.calendar.list(actor, from, to);
  }

  // Fixed paths before ':id'.
  @Get('context')
  @Can(CalendarPolicy, 'use')
  context(@CurrentActor() actor: Actor) {
    return this.calendar.context(actor);
  }

  @Get('people')
  @Can(CalendarPolicy, 'use')
  people(
    @CurrentActor() actor: Actor,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('for') purpose?: string,
  ) {
    const parsed = limit === undefined || limit === '' ? 20 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      throw new BadRequestException(
        'Limit must be a whole number from 1 to 50.',
      );
    }
    if (purpose !== undefined && purpose !== 'assign' && purpose !== 'invite') {
      throw new BadRequestException("for must be 'invite' or 'assign'.");
    }
    return this.calendar.people(actor, (q ?? '').trim().slice(0, 100), parsed, purpose === 'assign');
  }

  @Get(':id')
  @Can(CalendarPolicy, 'use')
  findOne(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.calendar.findOne(actor, id);
  }

  @Post()
  @Can(CalendarPolicy, 'use')
  create(@CurrentActor() actor: Actor, @Body() dto: CreateCalendarEventDto) {
    return this.calendar.create(actor, dto);
  }

  /** An edit, or `{ version, action: 'cancel', reason? }`. 409 when `version` is stale. */
  @Patch(':id')
  @Can(CalendarPolicy, 'use')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCalendarEventDto,
  ) {
    return this.calendar.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Can(CalendarPolicy, 'use')
  async remove(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.calendar.remove(actor, id);
  }
}
