# Zagreb Public Transport Live Map

A real-time map application that displays the current positions of public transport vehicles (trams and buses) in Zagreb, Croatia. The application uses the GTFS (General Transit Feed Specification) real-time feed provided by ZET (Zagreb Electric Tram).

## Features

- Real-time vehicle tracking with 10-second updates
- Different icons for trams (🚃) and buses (🚌)
- Route numbers displayed next to vehicles
- Detailed vehicle information in popups:
  - Vehicle type and line number
  - Vehicle ID and license plate
  - Current status and speed
  - Direction and occupancy information
  - Last update timestamp

## Technical Stack

- Node.js with Express for the backend server
- GTFS real-time protocol buffer for data parsing
- Leaflet.js for the interactive map
- OpenStreetMap for map tiles

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## Development

- The server automatically restarts when files change (using nodemon)
- Vehicle positions are updated every 10 seconds
- The map is centered on Zagreb with a zoom level suitable for viewing the entire city

## Data Source

The application uses the GTFS real-time feed from ZET:
- Feed URL: `https://www.zet.hr/gtfs-rt-protobuf`
- Protocol buffer definition: `proto/gtfs-realtime.proto`

## License

This project is open source and available under the MIT License. 