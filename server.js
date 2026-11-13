import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import ZagrebGTFSClient from './src/index.js';
import { createArchive, isNotFound } from './src/archive.js';

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

// Analytics outputs written by the nightly Python job under derived/<YYYY-MM-DD>/,
// in the R2 bucket when ARCHIVE_S3_* is set, else in data/.
const archive = createArchive();
const ANALYTICS_TTL_MS = parseInt(process.env.ANALYTICS_CACHE_TTL_MS || '600000', 10);
const ANALYTICS_MAX_ENTRIES = 40;
const analyticsCache = new Map(); // key -> { at, value }; Map order doubles as LRU order

async function cached(key, load) {
    const hit = analyticsCache.get(key);
    if (hit && Date.now() - hit.at < ANALYTICS_TTL_MS) {
        analyticsCache.delete(key);
        analyticsCache.set(key, hit);
        return hit.value;
    }
    const value = await load();
    analyticsCache.set(key, { at: Date.now(), value });
    while (analyticsCache.size > ANALYTICS_MAX_ENTRIES) analyticsCache.delete(analyticsCache.keys().next().value);
    return value;
}

app.get('/api/analytics/days', async (req, res) => {
    try {
        const days = await cached('days', async () => {
            // A day is listed once its summary exists; the job writes it last.
            const keys = await archive.list('derived/');
            return keys
                .map((k) => k.match(/^derived\/(\d{4}-\d{2}-\d{2})\/summary\.json$/)?.[1])
                .filter(Boolean)
                .sort()
                .reverse();
        });
        res.set('Cache-Control', 'public, max-age=300').json(days);
    } catch (error) {
        if (isNotFound(error)) return res.json([]);
        console.error('analytics days failed:', error.message);
        res.status(502).json({ error: 'analytics storage unavailable' });
    }
});

app.get('/api/analytics/:day/:file(summary.json|segments.geojson)', async (req, res) => {
    const { day, file } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).end();
    try {
        const body = await cached(`${day}/${file}`, () => archive.get(`derived/${day}/${file}`));
        // res.send sets an ETag and answers conditional requests with 304.
        res.set('Cache-Control', 'public, max-age=300').type(file.endsWith('.geojson') ? 'application/geo+json' : 'json').send(body);
    } catch (error) {
        if (isNotFound(error)) return res.status(404).json({ error: 'not processed' });
        console.error(`analytics ${day}/${file} failed:`, error.message);
        res.status(502).json({ error: 'analytics storage unavailable' });
    }
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