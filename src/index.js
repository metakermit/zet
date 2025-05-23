import fetch from 'node-fetch';
import protobuf from 'protobufjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// GTFS real-time feed URL for Zagreb
const GTFS_REALTIME_URL = process.env.GTFS_REALTIME_URL || 'https://www.zet.hr/gtfs-rt-protobuf';

class ZagrebGTFSClient {
    constructor() {
        this.protoRoot = null;
        this.FeedMessage = null;
    }

    async initialize() {
        try {
            // Load the GTFS real-time protocol buffer definition from local file
            const protoPath = join(__dirname, '..', 'proto', 'gtfs-realtime.proto');
            this.protoRoot = await protobuf.load(protoPath);
            this.FeedMessage = this.protoRoot.lookupType('transit_realtime.FeedMessage');
        } catch (error) {
            console.error('Failed to initialize GTFS client:', error);
            throw new Error(`GTFS initialization failed: ${error.message}`);
        }
    }

    async getVehiclePositions() {
        try {
            if (!this.FeedMessage) {
                await this.initialize();
            }

            // Fetch the real-time data
            const response = await fetch(GTFS_REALTIME_URL);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const buffer = await response.arrayBuffer();
            
            // Decode the protocol buffer message
            const message = this.FeedMessage.decode(new Uint8Array(buffer));
            const object = this.FeedMessage.toObject(message, {
                longs: String,
                enums: String,
                bytes: String,
            });

            return this.processVehiclePositions(object);
        } catch (error) {
            console.error('Error fetching vehicle positions:', error);
            throw error;
        }
    }

    processVehiclePositions(feed) {
        if (!feed.entity) {
            return [];
        }

        return feed.entity.map(entity => {
            const vehicle = entity.vehicle;
            if (!vehicle) return null;

            return {
                id: entity.id,
                vehicleId: vehicle.vehicle?.id,
                label: vehicle.vehicle?.label,
                licensePlate: vehicle.vehicle?.licensePlate,
                trip: {
                    tripId: vehicle.trip?.tripId,
                    routeId: vehicle.trip?.routeId,
                    scheduleRelationship: vehicle.trip?.scheduleRelationship
                },
                position: {
                    latitude: vehicle.position?.latitude,
                    longitude: vehicle.position?.longitude,
                    bearing: vehicle.position?.bearing,
                    speed: vehicle.position?.speed,
                },
                currentStatus: vehicle.currentStatus,
                timestamp: vehicle.timestamp,
                congestionLevel: vehicle.congestionLevel,
                occupancyStatus: vehicle.occupancyStatus,
            };
        }).filter(Boolean);
    }
}

// Example usage
async function main() {
    const client = new ZagrebGTFSClient();
    try {
        const positions = await client.getVehiclePositions();
        console.log('Current vehicle positions:', JSON.stringify(positions, null, 2));
    } catch (error) {
        console.error('Error:', error);
    }
}

// Run the example if this file is executed directly
if (process.argv[1] === import.meta.url) {
    main();
}

export default ZagrebGTFSClient; 