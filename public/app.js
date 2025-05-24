// Initialize the map centered on Zagreb
const map = L.map('map').setView([45.8150, 15.9819], 13);

// Add OpenStreetMap tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Store vehicle markers
const vehicleMarkers = new Map();

// Custom vehicle icons
const vehicleIcons = {
    tram: (routeId) => L.divIcon({
        className: 'vehicle-icon',
        html: `<div style="display: flex; align-items: center; gap: 4px;">
            <span style="font-size: 24px;">🚃</span>
            <span style="background: white; padding: 2px 4px; border-radius: 4px; font-weight: bold;">${routeId}</span>
        </div>`,
        iconSize: [72, 72],
        iconAnchor: [36, 36]
    }),
    bus: (routeId) => L.divIcon({
        className: 'vehicle-icon',
        html: `<div style="display: flex; align-items: center; gap: 4px;">
            <span style="font-size: 24px;">🚌</span>
            <span style="background: white; padding: 2px 4px; border-radius: 4px; font-weight: bold;">${routeId}</span>
        </div>`,
        iconSize: [72, 72],
        iconAnchor: [36, 36]
    })
};

// Function to determine vehicle type based on route number
function getVehicleType(vehicle) {
    // Try to get route ID from trip information
    const routeId = vehicle.trip?.routeId;
    if (routeId) {
        const routeNumber = parseInt(routeId);
        return (routeNumber < 100) ? 'tram' : 'bus';
    }
    
    // Fallback to always bus
    return 'bus';
}

// Function to create popup content
function createPopupContent(vehicle) {
    const vehicleType = getVehicleType(vehicle);
    const lineNumber = vehicle.trip?.routeId || vehicle.label || vehicle.vehicleId;
    
    // Format speed in km/h if available
    const speed = vehicle.position?.speed ? 
        Math.round(vehicle.position.speed * 3.6) + ' km/h' : 
        null;
    
    // Format bearing (direction) if available
    const bearing = vehicle.position?.bearing ? 
        Math.round(vehicle.position.bearing) + '°' : 
        null;
    
    // Format congestion level if available
    const congestionLevel = vehicle.congestionLevel ? 
        vehicle.congestionLevel.replace(/_/g, ' ').toLowerCase() : 
        null;
    
    // Format occupancy status if available
    const occupancyStatus = vehicle.occupancyStatus ? 
        vehicle.occupancyStatus.replace(/_/g, ' ').toLowerCase() : 
        null;

    // Build the popup content with only available fields
    const fields = [
        `<h3>${vehicleType === 'tram' ? 'Tram' : 'Bus'} Line ${lineNumber}</h3>`,
        vehicle.vehicleId && `<p>Vehicle ID: ${vehicle.vehicleId}</p>`,
        vehicle.trip?.routeId && `<p>Route ID: ${vehicle.trip.routeId}</p>`,
        vehicle.trip?.tripId && `<p>Trip ID: ${vehicle.trip.tripId}</p>`,
        vehicle.licensePlate && `<p>License Plate: ${vehicle.licensePlate}</p>`,
        vehicle.currentStatus && `<p>Status: ${vehicle.currentStatus}</p>`,
        speed && `<p>Speed: ${speed}</p>`,
        bearing && `<p>Direction: ${bearing}</p>`,
        congestionLevel && `<p>Congestion: ${congestionLevel}</p>`,
        occupancyStatus && `<p>Occupancy: ${occupancyStatus}</p>`,
        vehicle.timestamp && `<p>Last Update: ${new Date(vehicle.timestamp * 1000).toLocaleTimeString()}</p>`
    ].filter(Boolean).join('');

    return `<div class="vehicle-popup">${fields}</div>`;
}

// Function to update vehicle positions
async function updateVehiclePositions() {
    try {
        const response = await fetch('/api/vehicles');
        const vehicles = await response.json();

        // Remove vehicles that are no longer in the feed
        for (const [id, marker] of vehicleMarkers) {
            if (!vehicles.find(v => v.id === id)) {
                marker.remove();
                vehicleMarkers.delete(id);
            }
        }

        // Update or add vehicle markers
        vehicles.forEach(vehicle => {
            if (!vehicle.position?.latitude || !vehicle.position?.longitude) return;

            const position = [vehicle.position.latitude, vehicle.position.longitude];
            const popupContent = createPopupContent(vehicle);
            const vehicleType = getVehicleType(vehicle);
            const routeId = vehicle.trip?.routeId || vehicle.label || vehicle.vehicleId;
            const icon = vehicleIcons[vehicleType](routeId);

            if (vehicleMarkers.has(vehicle.id)) {
                // Update existing marker
                const marker = vehicleMarkers.get(vehicle.id);
                marker.setLatLng(position);
                marker.getPopup().setContent(popupContent);
                marker.setIcon(icon);
            } else {
                // Create new marker
                const marker = L.marker(position, { icon })
                    .bindPopup(popupContent)
                    .addTo(map);
                vehicleMarkers.set(vehicle.id, marker);
            }
        });
    } catch (error) {
        console.error('Error updating vehicle positions:', error);
    }
}

// Update positions every 10 seconds
updateVehiclePositions();
setInterval(updateVehiclePositions, 10000); 