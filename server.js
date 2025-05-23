import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ZagrebGTFSClient from './src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3000;

// Initialize GTFS client
const gtfsClient = new ZagrebGTFSClient();

// Serve static files from the public directory
app.use(express.static(join(__dirname, 'public')));

// API endpoint for vehicle positions
app.get('/api/vehicles', async (req, res) => {
    try {
        const positions = await gtfsClient.getVehiclePositions();
        // Log the first few vehicles to see their structure
        console.log('Raw vehicle data (first 5 vehicles):');
        positions.slice(0, 5).forEach(vehicle => {
            console.log(JSON.stringify(vehicle, null, 2));
        });
        res.json(positions);
    } catch (error) {
        console.error('Error fetching vehicle positions:', error);
        res.status(500).json({ error: 'Failed to fetch vehicle positions' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 