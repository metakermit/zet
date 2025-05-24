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

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Initialize client before handling requests
let clientInitialized = false;
app.use(async (req, res, next) => {
    if (!clientInitialized) {
        try {
            await client.initialize();
            clientInitialized = true;
        } catch (error) {
            console.error('Failed to initialize GTFS client:', error);
            return res.status(500).json({ 
                error: 'Service initialization failed',
                message: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
    next();
});

// Serve static files from the public directory
app.use(express.static(join(__dirname, 'public')));

// API endpoint for vehicle positions
app.get('/api/vehicles', async (req, res) => {
    try {
        const positions = await client.getVehiclePositions();
        res.json(positions);
    } catch (error) {
        console.error('Error fetching vehicle positions:', error);
        res.status(500).json({ 
            error: 'Failed to fetch vehicle positions',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
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