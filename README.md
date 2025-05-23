# Zagreb GTFS Client

A JavaScript client for parsing real-time public transport vehicle positions in Zagreb using the GTFS real-time feed.

## Installation

```bash
npm install
```

## Usage

```javascript
import ZagrebGTFSClient from './src/index.js';

const client = new ZagrebGTFSClient();

// Get current vehicle positions
const positions = await client.getVehiclePositions();
console.log(positions);
```

The client will return an array of vehicle positions with the following information for each vehicle:

- `id`: Unique identifier for the vehicle update
- `vehicleId`: The vehicle's unique identifier
- `label`: The vehicle's label (usually the route number)
- `licensePlate`: The vehicle's license plate number
- `position`: Object containing:
  - `latitude`: Current latitude
  - `longitude`: Current longitude
  - `bearing`: Direction of travel in degrees
  - `speed`: Current speed
- `currentStatus`: Current status of the vehicle
- `timestamp`: Last update timestamp
- `congestionLevel`: Current congestion level
- `occupancyStatus`: Current occupancy status

## Running the Example

```bash
npm start
```

This will fetch and display the current positions of all vehicles in the system.

## Notes

- The client uses the GTFS real-time protocol buffer format
- Data is fetched from the official ZET GTFS feed
- The client automatically handles protocol buffer decoding and data processing 