# London Bus Pulse

An interactive D3 visualization of six central TfL bus corridors, styled as a restrained transit narrative with a real London map, Marey-style service diagram, an independently filterable passenger heatmap, crowding bands with a selected-route profile, and a scheduled two-stop ride explorer.

## Run

```powershell
node server.js
```

Then open <http://localhost:8080/>.

The page is static and uses CDN copies of D3 and Leaflet. It can also be opened directly as `index.html`, but the local server is recommended.

## Data

- `data_raw/busto_weekday_routes_1_149.csv` is the downloaded TfL BUSTO 2025-2026 weekday route demand file.
- `data/london_bus_pulse.js` and `data/london_bus_pulse.json` are generated browser-ready extracts.
- `tools/process_tfl_data.py` filters six routes, fetches TfL route geometry/timetables, caches TfL API responses, and writes the processed data.
- The ride explorer combines TfL scheduled timetable points with typical BUSTO quarter-hour passenger demand. It is not live delay data.
- The main sections keep separate local time cursors: buses/header, passenger heatmap, crowding/profile, and ride explorer do not force each other to the same moment.

Selected routes: 24, 29, 38, 73, 25, and 149.
