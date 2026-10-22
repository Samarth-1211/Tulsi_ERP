import { Module } from '@nestjs/common';
import { CitiesController, TripsController } from './controllers/trips.controller';
import { TripsService } from './services/trips.service';
import { OsmService } from './services/osm.service';
import { CityGeocodingService } from './services/city-geocoding.service';

@Module({
  controllers: [TripsController, CitiesController],
  providers: [TripsService, OsmService, CityGeocodingService],
})
export class TripsModule {}
