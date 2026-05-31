import csv
import json
import math
import pathlib
import re
import time
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW_CSV = ROOT / "data_raw" / "busto_weekday_routes_1_149.csv"
OUT_JSON = ROOT / "data" / "london_bus_pulse.json"
OUT_JS = ROOT / "data" / "london_bus_pulse.js"
API_CACHE = ROOT / "data_raw" / "tfl_api_cache"

ROUTES = [
    {
        "id": "24",
        "label": "24",
        "name": "Pimlico / Westminster - Hampstead Heath",
        "note": "Iconic central corridor near Westminster, Trafalgar Square, Camden.",
        "color": "#8B5E4A",
    },
    {
        "id": "29",
        "label": "29",
        "name": "Wood Green - Trafalgar Square",
        "note": "One of the strongest BUSTO passenger corridors in the 1-149 file.",
        "color": "#B64A3C",
    },
    {
        "id": "38",
        "label": "38",
        "name": "Clapton Pond - Victoria",
        "note": "High-load east-to-central route ending at Victoria.",
        "color": "#2F6F73",
    },
    {
        "id": "73",
        "label": "73",
        "name": "Oxford Circus - Stoke Newington",
        "note": "Oxford Street and Euston corridor with strong peak-period loading.",
        "color": "#617341",
    },
    {
        "id": "25",
        "label": "25",
        "name": "Ilford - Holborn Circus",
        "note": "Heavy east-west demand into the City and Holborn.",
        "color": "#A77B31",
    },
    {
        "id": "149",
        "label": "149",
        "name": "Edmonton Green - London Bridge",
        "note": "High-volume north-to-London Bridge corridor.",
        "color": "#6F647D",
    },
]

ROUTE_IDS = {route["id"] for route in ROUTES}
DIRECTION_NAME = {"1": "outbound", "2": "inbound"}
DAY_NAME = "Monday to Thursday"


def get_json(url):
    API_CACHE.mkdir(parents=True, exist_ok=True)
    cache_name = re.sub(r"[^a-zA-Z0-9]+", "_", url).strip("_") + ".json"
    cache_path = API_CACHE / cache_name
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))

    last_error = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=90) as response:
                text = response.read().decode("utf-8")
            cache_path.write_text(text, encoding="utf-8")
            return json.loads(text)
        except Exception as exc:
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise last_error


def minutes_from_qhr(value):
    hour, minute, *_ = value.split(":")
    return int(hour) * 60 + int(minute)


def clean_number(value):
    if value is None or value == "":
        return 0.0
    try:
        return round(float(value), 3)
    except ValueError:
        return 0.0


def flatten_linestring(line_strings):
    paths = []
    for raw in line_strings:
        parsed = json.loads(raw)
        for part in parsed:
            if not part:
                continue
            if isinstance(part[0][0], list):
                for subpart in part:
                    paths.append([[round(lon, 6), round(lat, 6)] for lon, lat in subpart])
            else:
                paths.append([[round(lon, 6), round(lat, 6)] for lon, lat in part])
    return paths


def normalize_name(name):
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def fetch_route_direction(route_id, direction):
    url = f"https://api.tfl.gov.uk/Line/{route_id}/Route/Sequence/{direction}"
    data = get_json(url)
    sequence = data["stopPointSequences"][0]["stopPoint"]
    stops = [
        {
            "id": stop["id"],
            "name": stop["name"],
            "lat": round(stop["lat"], 6),
            "lon": round(stop["lon"], 6),
            "index": i,
        }
        for i, stop in enumerate(sequence)
    ]
    return {
        "lineId": data["lineId"],
        "direction": direction,
        "paths": flatten_linestring(data.get("lineStrings", [])),
        "stops": stops,
        "from": stops[0]["name"],
        "to": stops[-1]["name"],
    }


def fetch_timetable(route_id, direction_data):
    first_stop = direction_data["stops"][0]["id"]
    url = f"https://api.tfl.gov.uk/Line/{route_id}/Timetable/{first_stop}"
    try:
        data = get_json(url)
    except Exception:
        return []

    route = (data.get("timetable", {}).get("routes") or [{}])[0]
    intervals_by_id = {}
    for station_interval in route.get("stationIntervals", []):
        key = int(station_interval.get("id", 0))
        intervals_by_id[key] = station_interval.get("intervals", [])

    schedule = None
    for candidate in route.get("schedules", []):
        if candidate.get("name") == DAY_NAME:
            schedule = candidate
            break
    if schedule is None and route.get("schedules"):
        schedule = route["schedules"][0]
    if schedule is None:
        return []

    stop_index = {stop["id"]: stop["index"] for stop in direction_data["stops"]}
    trips = []
    for journey in schedule.get("knownJourneys", []):
        depart = int(journey.get("hour", 0)) * 60 + int(journey.get("minute", 0))
        if depart < 0 or depart > 24 * 60:
            continue
        interval_id = int(journey.get("intervalId", 0))
        points = []
        for interval in intervals_by_id.get(interval_id, []):
            sid = interval.get("stopId")
            if sid not in stop_index:
                continue
            points.append([stop_index[sid], round(depart + float(interval.get("timeToArrival", 0)), 2)])
        if len(points) > 3:
            trips.append({"depart": depart, "points": points})
    return trips


def read_busto():
    by_key = {}
    route_summary = {
        route_id: {"boardings": 0.0, "alightings": 0.0, "maxLoad": 0.0, "maxVC": 0.0}
        for route_id in ROUTE_IDS
    }
    stop_names = {}

    with RAW_CSV.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            route_id = row["ROUTE"]
            if route_id not in ROUTE_IDS:
                continue
            direction_id = row["DIRECTION"]
            minute = minutes_from_qhr(row["QHr"])
            seq = int(float(row["STOPSEQUENCE"])) - 1
            key = (route_id, direction_id, minute)
            entry = by_key.setdefault(key, [])
            boardings = clean_number(row["Boardings"])
            alightings = clean_number(row["Alightings"])
            load = clean_number(row["Load"])
            vc = clean_number(row["V/C"])
            entry.append(
                {
                    "i": seq,
                    "b": boardings,
                    "a": alightings,
                    "l": load,
                    "vc": vc,
                }
            )
            route_summary[route_id]["boardings"] += boardings
            route_summary[route_id]["alightings"] += alightings
            route_summary[route_id]["maxLoad"] = max(route_summary[route_id]["maxLoad"], load)
            route_summary[route_id]["maxVC"] = max(route_summary[route_id]["maxVC"], vc)
            stop_names[(route_id, direction_id, seq)] = row["STOPNAME"]

    demand = []
    for (route_id, direction_id, minute), stops in sorted(by_key.items()):
        stops.sort(key=lambda item: item["i"])
        demand.append(
            {
                "route": route_id,
                "dir": direction_id,
                "minute": minute,
                "stops": stops,
            }
        )

    top_stops = []
    stop_totals = {}
    for item in demand:
        for stop in item["stops"]:
            key = (item["route"], item["dir"], stop["i"])
            agg = stop_totals.setdefault(key, {"b": 0.0, "a": 0.0, "maxLoad": 0.0})
            agg["b"] += stop["b"]
            agg["a"] += stop["a"]
            agg["maxLoad"] = max(agg["maxLoad"], stop["l"])
    for (route_id, direction_id, seq), agg in stop_totals.items():
        top_stops.append(
            {
                "route": route_id,
                "dir": direction_id,
                "i": seq,
                "name": stop_names.get((route_id, direction_id, seq), ""),
                "boardings": round(agg["b"], 2),
                "alightings": round(agg["a"], 2),
                "maxLoad": round(agg["maxLoad"], 2),
            }
        )
    top_stops.sort(key=lambda item: item["boardings"] + item["alightings"], reverse=True)

    for stats in route_summary.values():
        for key in stats:
            stats[key] = round(stats[key], 2)

    return demand, route_summary, top_stops[:30]


def main():
    if not RAW_CSV.exists():
        raise SystemExit(f"Missing {RAW_CSV}")

    demand, route_summary, top_stops = read_busto()
    route_data = {}
    for route in ROUTES:
        directions = {}
        for direction_id, direction_name in DIRECTION_NAME.items():
            direction_data = fetch_route_direction(route["id"], direction_name)
            direction_data["trips"] = fetch_timetable(route["id"], direction_data)
            direction_data["dirId"] = direction_id
            directions[direction_id] = direction_data
        route_data[route["id"]] = {
            **route,
            "summary": route_summary[route["id"]],
            "directions": directions,
        }

    output = {
        "meta": {
            "title": "London Bus Pulse",
            "source": "TfL BUSTO 2025-2026 weekday typical demand and TfL Unified API route geometry/timetables.",
            "routes": [route["id"] for route in ROUTES],
            "timeRange": [0, 24 * 60 - 15],
            "generated": "local",
        },
        "routes": route_data,
        "demand": demand,
        "topStops": top_stops,
        "landmarks": [
            {"id": "big-ben", "name": "Big Ben", "lat": 51.500729, "lon": -0.124625},
            {"id": "trafalgar", "name": "Trafalgar Square", "lat": 51.508, "lon": -0.1281},
            {"id": "victoria", "name": "Victoria", "lat": 51.4952, "lon": -0.1441},
            {"id": "london-bridge", "name": "London Bridge", "lat": 51.5055, "lon": -0.0754},
            {"id": "oxford-circus", "name": "Oxford Circus", "lat": 51.5152, "lon": -0.1419},
        ],
    }

    OUT_JSON.write_text(json.dumps(output, separators=(",", ":")), encoding="utf-8")
    OUT_JS.write_text(
        "window.LONDON_BUS_PULSE_DATA = "
        + json.dumps(output, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(f"Wrote {OUT_JSON} ({OUT_JSON.stat().st_size / 1024 / 1024:.2f} MB)")
    print(f"Wrote {OUT_JS} ({OUT_JS.stat().st_size / 1024 / 1024:.2f} MB)")
    print("Routes:")
    for route in ROUTES:
        stats = route_summary[route["id"]]
        print(
            f"  {route['id']:>3}: boardings={stats['boardings']:.0f}, "
            f"maxLoad={stats['maxLoad']:.1f}, maxV/C={stats['maxVC']:.2f}"
        )


if __name__ == "__main__":
    main()
