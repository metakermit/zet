import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ZagrebGTFSClient from './src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Initialize GTFS client
const client = new ZagrebGTFSClient();
await client.initialize();

// Serve static files from the public directory
app.use(express.static(join(__dirname, 'public')));

// API endpoint for vehicle positions
app.get('/api/vehicles', async (req, res) => {
    try {
        const positions = await client.getVehiclePositions();
        res.json(positions);
    } catch (error) {
        console.error('Error fetching vehicle positions:', error);
        res.status(500).json({ error: 'Failed to fetch vehicle positions' });
    }
});

// Handle all other routes by serving index.html
app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Only start the server if we're not in a serverless environment
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}

export default app; 