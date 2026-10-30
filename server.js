import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { readdir } from 'fs/promises';
import ZagrebGTFSClient from './src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Initialize GTFS client
const client = new ZagrebGTFSClient();

// Global error handler
app.use((err, req, res, next) => {
    // Detailed error logging for debugging
    console.error('Unhandled error:', {
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        body: req.body,
        query: req.query
    });
    
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
        // Include stack trace in development
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Render health check; registered before the init middleware so it never touches the feed.
app.get('/healthz', (req, res) => res.send('ok'));

// Initialize client before handling requests
let clientInitialized = false;
app.use(async (req, res, next) => {
    if (!clientInitialized) {
        try {
            // Breakpoint opportunity: Client initialization
            await client.initialize();
            clientInitialized = true;
        } catch (error) {
            console.error('Failed to initialize GTFS client:', {
                message: error.message,
                stack: error.stack
            });
            return res.status(500).json({ 
                error: 'Service initialization failed',
                message: process.env.NODE_ENV === 'development' ? error.message : undefined,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    }
    next();
});

// Serve static files from the public directory
app.use(express.static(join(__dirname, 'public')));

// Cache configuration
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '10000', 10); // Default 10 seconds
let vehicleCache = {
    data: null,
    timestamp: null
};

// API endpoint for vehicle positions
app.get('/api/vehicles', async (req, res) => {
    try {
        const now = Date.now();
        
        // Check if cache is still valid
        if (vehicleCache.data && vehicleCache.timestamp && (now - vehicleCache.timestamp) < CACHE_TTL_MS) {
            // Return cached data
            return res.json(vehicleCache.data);
        }
        
        // Breakpoint opportunity: Before fetching positions
        const positions = await client.getVehiclePositions();
        
        // Update cache
        vehicleCache = {
            data: positions,
            timestamp: now
        };
        
        res.json(positions);
    } catch (error) {
        // Breakpoint opportunity: Error handling
        console.error('Error fetching vehicle positions:', {
            message: error.message,
            stack: error.stack
        });
        
        // If we have cached data, return it even if it's stale (better than nothing)
        if (vehicleCache.data) {
            console.log('Returning stale cache due to error');
            return res.json(vehicleCache.data);
        }
        
        res.status(500).json({ 
            error: 'Failed to fetch vehicle positions',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Analytics outputs written by the Python jobs (data/derived/<YYYY-MM-DD>/).
const DERIVED_DIR = join(process.env.ARCHIVE_DIR || join(__dirname, 'data'), 'derived');

app.get('/api/analytics/days', async (req, res) => {
    try {
        const entries = await readdir(DERIVED_DIR, { withFileTypes: true });
        const days = entries
            .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
            .map((e) => e.name)
            .sort()
            .reverse();
        res.json(days);
    } catch (error) {
        if (error.code === 'ENOENT') return res.json([]);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/analytics/:day/:file(summary.json|segments.geojson)', (req, res) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.day)) return res.status(400).end();
    res.sendFile(join(DERIVED_DIR, req.params.day, req.params.file), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: 'not processed' });
    });
});

app.get('/analytics', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'analytics.html'));
});

// Handle all other routes by serving index.html
app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Function to get local network IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);
    if (process.env.NODE_ENV !== 'production') {
        const localIP = getLocalIP();
        console.log(`Server accessible on network at http://${localIP}:${port}`);
        console.log('Debugger is available. To start debugging:');
        console.log('1. Open Chrome DevTools');
        console.log('2. Click the Node.js icon or visit chrome://inspect');
        console.log('3. Click "Open dedicated DevTools for Node"');
    }
});

export default app; 