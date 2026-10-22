import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role, TripLeadFilter } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { TripsService } from '../services/trips.service';
import { CityGeocodingService } from '../services/city-geocoding.service';
import { CreateTripDto, OptimiseStopsDto, PlanTripDto, ShareTripDto, TripLeadsDto, TripTasksDto, UpdateCityDto, UpdateTripDto } from '../dto/trip.dto';

const LEAD_ROLES = [Role.ADMIN, Role.MANAGER, Role.CALLER];
// Anyone a trip can be shared with — delivery partners and warehouse staff included.
const ORG_ROLES = [Role.ADMIN, Role.MANAGER, Role.CALLER, Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF];

@ApiTags('trips')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get('places')
  @Roles(...LEAD_ROLES)
  @ApiQuery({ name: 'q', required: true })
  @ApiOperation({ summary: 'Search a From / To / stop: the org’s lead cities first, then towns from OpenStreetMap' })
  places(@CurrentUser() actor: AuthenticatedUser, @Query('q') q: string) {
    return this.trips.places(actor, q);
  }

  @Get('cities')
  @Roles(...LEAD_ROLES)
  @ApiQuery({ name: 'leadFilter', required: false, enum: TripLeadFilter })
  @ApiQuery({ name: 'includeLost', required: false, type: Boolean })
  @ApiOperation({ summary: 'Every lead city on the map with its lead counts (your scope)' })
  cities(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('leadFilter') leadFilter?: TripLeadFilter,
    @Query('includeLost') includeLost?: string,
  ) {
    return this.trips.cities(
      actor,
      Object.values(TripLeadFilter).includes(leadFilter as TripLeadFilter) ? leadFilter : undefined,
      includeLost === 'true',
    );
  }

  @Post('optimise')
  @Roles(...LEAD_ROLES)
  @ApiOperation({ summary: 'Put the stops in the shortest driving order (first and last stay put); returns km/time before and after' })
  optimise(@Body() dto: OptimiseStopsDto) {
    return this.trips.optimise(dto.stops);
  }

  @Post('plan')
  @Roles(...LEAD_ROLES)
  @ApiOperation({ summary: 'Road route through the stops and the lead cities within corridorKm of it, in travel order' })
  plan(@CurrentUser() actor: AuthenticatedUser, @Body() dto: PlanTripDto) {
    return this.trips.plan(actor, dto);
  }

  @Post('leads')
  @Roles(...LEAD_ROLES)
  @ApiOperation({ summary: 'Your leads in the picked cities, grouped by city in the given order' })
  leads(@CurrentUser() actor: AuthenticatedUser, @Body() dto: TripLeadsDto) {
    return this.trips.leads(actor, dto.cityIds, dto.leadFilter, dto.includeLost);
  }

  @Get('share-candidates')
  @Roles(...LEAD_ROLES)
  @ApiOperation({ summary: 'People in the org a trip can be shared with' })
  shareCandidates(@CurrentUser() actor: AuthenticatedUser) {
    return this.trips.shareCandidates(actor);
  }

  @Get()
  @Roles(...ORG_ROLES)
  @ApiOperation({ summary: 'Trips you planned or that were shared with you (Admin: all in the org)' })
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.trips.list(actor);
  }

  @Post()
  @Roles(...LEAD_ROLES)
  @ApiOperation({ summary: 'Save a planned trip' })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateTripDto) {
    return this.trips.create(actor, dto);
  }

  @Get(':id')
  @Roles(...ORG_ROLES)
  @ApiOperation({ summary: 'One saved trip (planner, Admin, or someone it is shared with)' })
  get(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.trips.get(actor, id);
  }

  @Get(':id/leads')
  @Roles(...ORG_ROLES)
  @ApiOperation({ summary: "The trip's leads by city, as its planner sees them" })
  tripLeads(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.trips.tripLeads(actor, id);
  }

  @Patch(':id')
  @Roles(...LEAD_ROLES)
  @ApiOperation({ summary: 'Change a trip (planner or Admin)' })
  update(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateTripDto) {
    return this.trips.update(actor, id, dto);
  }

  @Delete(':id')
  @Roles(...LEAD_ROLES)
  @ApiOperation({ summary: 'Delete a trip (planner or Admin); its visit tasks stay' })
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.trips.remove(actor, id);
  }

  @Post(':id/share')
  @Roles(...LEAD_ROLES)
  @ApiOperation({ summary: 'Set who the trip is shared with (planner or Admin); newly added people are notified' })
  share(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: ShareTripDto) {
    return this.trips.share(actor, id, dto.userIds);
  }

  @Post(':id/tasks')
  @Roles(...ORG_ROLES)
  @ApiOperation({ summary: 'Save the trip as site-visit tasks (one per lead) for the planner or someone it is shared with' })
  saveAsTasks(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: TripTasksDto) {
    return this.trips.saveAsTasks(actor, id, dto.userId);
  }
}

@ApiTags('settings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('cities')
export class CitiesController {
  constructor(private readonly geocoding: CityGeocodingService) {}

  @Get()
  @ApiOperation({ summary: 'Every lead city with its map location, spelling status and lead count (Admin)' })
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.geocoding.list(actor);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename and/or place a city by hand; renaming onto an existing city merges the two (Admin)' })
  update(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateCityDto) {
    return this.geocoding.update(actor, id, dto);
  }

  @Post(':id/locate')
  @ApiOperation({ summary: 'Look the city up on the map again (Admin)' })
  retry(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.geocoding.retry(actor, id);
  }
}
