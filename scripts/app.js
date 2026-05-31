(function () {
  "use strict";

  const data = window.LONDON_BUS_PULSE_DATA;
  const ALL_ROUTES = "all";
  const routeIds = data.meta.routes;
  const routes = routeIds.map((id) => data.routes[id]);
  const timeRange = data.meta.timeRange;
  const timebands = Array.from(new Set(data.demand.map((d) => d.minute))).sort((a, b) => a - b);
  const demandIndex = new Map(data.demand.map((d) => [`${d.route}|${d.dir}|${d.minute}`, d]));
  const maxLoad = d3.max(data.demand, (d) => d3.max(d.stops, (s) => s.l));
  const maxBoard = d3.max(data.demand, (d) => d3.max(d.stops, (s) => s.b));
  const maxVC = d3.max(data.demand, (d) => d3.max(d.stops, (s) => s.vc));

  const state = {
    busTime: 8 * 60,
    passengerTime: 8 * 60,
    crowdingTime: 8 * 60,
    rideTime: 8 * 60,
    activeRoute: ALL_ROUTES,
    passengerRoute: "24",
    crowdingRoute: "24",
    rideRoute: "24",
    playing: true,
    hoverStop: null,
    passengerHoverStop: null,
    rideSelection: null,
    rideDragging: false,
  };

  const tooltip = d3.select("body").append("div").attr("class", "tooltip").style("display", "none");

  const colorByRoute = new Map(routes.map((route) => [route.id, route.color]));
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const detailRouteId = () => state.activeRoute === ALL_ROUTES ? "24" : state.activeRoute;
  const passengerRouteId = () => state.passengerRoute || "24";
  const crowdingRouteId = () => state.crowdingRoute || "24";
  const rideRouteId = () => state.rideRoute || "24";
  const isNetworkMode = () => state.activeRoute === ALL_ROUTES;
  const routeIsActive = (routeId) => isNetworkMode() || routeId === state.activeRoute;

  routes.forEach((route) => {
    Object.values(route.directions).forEach((direction) => {
      direction.metric = buildPathMetric(direction.paths, direction.stops);
    });
  });

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatTime(minute) {
    const wrapped = ((Math.round(minute) % (24 * 60)) + 24 * 60) % (24 * 60);
    return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
  }

  function nearestTime(minute) {
    const clamped = Math.max(timeRange[0], Math.min(timeRange[1], minute));
    return Math.round(clamped / 15) * 15;
  }

  function getDemand(routeId, dirId, minute = state.busTime) {
    return demandIndex.get(`${routeId}|${dirId}|${nearestTime(minute)}`);
  }

  function getStopDemand(routeId, dirId, stopIndex, minute = state.busTime) {
    const record = getDemand(routeId, dirId, minute);
    return record ? record.stops.find((s) => s.i === stopIndex) : null;
  }

  function coordDistance(a, b) {
    const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    const dy = b[1] - a[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function pathLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
      total += coordDistance(coords[i - 1], coords[i]);
    }
    return total;
  }

  function stopFitScore(coords, stops) {
    if (!stops.length) return -pathLength(coords);
    const step = Math.max(1, Math.floor(stops.length / 12));
    const sampledStops = stops.filter((_, index) => index % step === 0 || index === stops.length - 1);
    const total = sampledStops.reduce((sum, stop) => {
      const stopCoord = [stop.lon, stop.lat];
      const nearest = coords.reduce((best, coord) => Math.min(best, coordDistance(stopCoord, coord)), Infinity);
      return sum + nearest;
    }, 0);
    return total / sampledStops.length;
  }

  function buildPathMetric(paths, stops = []) {
    const connectedChains = [];
    const cleanPaths = paths.filter((path) => path.length > 1);
    const maxJoinGap = 0.006;
    let currentChain = [];
    cleanPaths.forEach((path) => {
      if (!currentChain.length) {
        currentChain = [...path];
        return;
      }
      const gap = coordDistance(currentChain[currentChain.length - 1], path[0]);
      if (gap <= maxJoinGap) {
        currentChain.push(...path.slice(1));
      } else {
        connectedChains.push(currentChain);
        currentChain = [...path];
      }
    });
    if (currentChain.length) connectedChains.push(currentChain);

    const coords = connectedChains.length
      ? connectedChains.reduce((best, chain) => (stopFitScore(chain, stops) < stopFitScore(best, stops) ? chain : best))
      : [];
    const distances = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
      total += coordDistance(coords[i - 1], coords[i]);
      distances.push(total);
    }
    return { coords, distances, total };
  }

  function pointAlong(metric, fraction) {
    if (!metric.coords.length) return null;
    if (fraction <= 0) return metric.coords[0];
    if (fraction >= 1) return metric.coords[metric.coords.length - 1];
    const target = metric.total * fraction;
    const index = d3.bisectLeft(metric.distances, target);
    const prev = Math.max(0, index - 1);
    const next = Math.min(metric.coords.length - 1, index);
    const span = metric.distances[next] - metric.distances[prev] || 1;
    const local = (target - metric.distances[prev]) / span;
    return [
      metric.coords[prev][0] + (metric.coords[next][0] - metric.coords[prev][0]) * local,
      metric.coords[prev][1] + (metric.coords[next][1] - metric.coords[prev][1]) * local,
    ];
  }

  function activeBuses(route, dirId, minute = state.busTime) {
    const direction = route.directions[dirId];
    return direction.trips
      .filter((trip) => {
        const points = trip.points;
        return points.length && minute >= points[0][1] && minute <= points[points.length - 1][1];
      })
      .map((trip) => {
        const points = trip.points;
        const start = points[0][1];
        const end = points[points.length - 1][1];
        const fraction = (minute - start) / Math.max(1, end - start);
        const coord = pointAlong(direction.metric, fraction);
        return { route: route.id, dir: dirId, coord, fraction };
      })
      .filter((d) => d.coord);
  }

  function setBusTime(minute, fromUser) {
    state.busTime = nearestTime(minute);
    if (fromUser) state.playing = false;
    updateBuses();
  }

  function setPassengerTime(minute) {
    state.passengerTime = nearestTime(minute);
    updatePassenger();
  }

  function setCrowdingTime(minute) {
    state.crowdingTime = nearestTime(minute);
    updateCrowding();
  }

  function setRideTime(minute) {
    state.rideTime = nearestTime(minute);
    updateRide();
  }

  function setRoute(routeId) {
    state.activeRoute = routeId;
    state.hoverStop = null;
    renderRouteTabs();
    drawMarey();
    updateBuses();
  }

  function setPassengerRoute(routeId) {
    state.passengerRoute = routeId;
    state.passengerHoverStop = null;
    renderPassengerRouteTabs();
    drawHeatmap();
    updatePassenger();
  }

  function setCrowdingRoute(routeId) {
    if (!routeById.has(routeId)) return;
    state.crowdingRoute = routeId;
    updateCrowding();
  }

  function setRideRoute(routeId) {
    if (!routeById.has(routeId)) return;
    state.rideRoute = routeId;
    state.rideSelection = defaultSelection(routeId);
    renderRideRouteTabs();
    drawRideSelector();
    updateRide();
  }

  function showTooltip(html, event) {
    tooltip.html(html)
      .style("display", "block")
      .style("left", `${event.clientX + 14}px`)
      .style("top", `${event.clientY + 14}px`);
  }

  function hideTooltip() {
    tooltip.style("display", "none");
  }

  window.addEventListener("scroll", hideTooltip, { passive: true });

  function summarizeRouteAt(routeId, minute = state.busTime) {
    if (routeId === ALL_ROUTES) {
      const summaries = routeIds.map((id) => summarizeRouteAt(id, minute));
      return {
        load: d3.max(summaries, (d) => d.load) || 0,
        board: d3.sum(summaries, (d) => d.board),
        alight: d3.sum(summaries, (d) => d.alight),
        vc: d3.max(summaries, (d) => d.vc) || 0,
      };
    }
    let load = 0;
    let board = 0;
    let alight = 0;
    let vc = 0;
    ["1", "2"].forEach((dir) => {
      const demand = getDemand(routeId, dir, minute);
      if (!demand) return;
      load = Math.max(load, d3.max(demand.stops, (s) => s.l) || 0);
      board += d3.sum(demand.stops, (s) => s.b);
      alight += d3.sum(demand.stops, (s) => s.a);
      vc = Math.max(vc, d3.max(demand.stops, (s) => s.vc) || 0);
    });
    return { load, board, alight, vc };
  }

  function renderRouteTabs() {
    const tabs = [{ id: ALL_ROUTES, label: "All", color: "#35312c" }, ...routes];
    d3.select("#route-tabs")
      .selectAll("button")
      .data(tabs, (d) => d.id)
      .join("button")
      .attr("class", (d) => `route-tab${d.id === ALL_ROUTES ? " network" : ""}${d.id === state.activeRoute ? " active" : ""}`)
      .style("border-color", (d) => d.id === state.activeRoute ? d.color : null)
      .style("background", (d) => d.id === state.activeRoute ? d.color : null)
      .text((d) => d.label)
      .on("click", (_, d) => setRoute(d.id));
  }

  function renderPassengerRouteTabs() {
    d3.select("#passenger-route-tabs")
      .selectAll("button")
      .data(routes, (d) => d.id)
      .join("button")
      .attr("class", (d) => `route-tab${d.id === state.passengerRoute ? " active" : ""}`)
      .style("border-color", (d) => d.id === state.passengerRoute ? d.color : null)
      .style("background", (d) => d.id === state.passengerRoute ? d.color : null)
      .text((d) => d.label)
      .on("click", (_, d) => setPassengerRoute(d.id));
  }

  function renderRideRouteTabs() {
    d3.select("#ride-route-tabs")
      .selectAll("button")
      .data(routes, (d) => d.id)
      .join("button")
      .attr("class", (d) => `route-tab${d.id === state.rideRoute ? " active" : ""}`)
      .style("border-color", (d) => d.id === state.rideRoute ? d.color : null)
      .style("background", (d) => d.id === state.rideRoute ? d.color : null)
      .text((d) => d.label)
      .on("click", (_, d) => setRideRoute(d.id));
  }

  d3.select("#play-button").on("click", function () {
    state.playing = !state.playing;
    d3.select(this).classed("active", !state.playing).text(state.playing ? "pause" : "play");
  });

  renderRouteTabs();
  renderPassengerRouteTabs();
  renderRideRouteTabs();

  /* Header clock and miniature route network */
  const clockSvg = d3.select("#clock-viz");
  const mini = clockSvg.select(".mini-network");
  const allMiniCoords = routes.flatMap((route) =>
    Object.values(route.directions).flatMap((direction) => direction.paths.flat())
  );
  const lonExtent = d3.extent(allMiniCoords, (d) => d[0]);
  const latExtent = d3.extent(allMiniCoords, (d) => d[1]);
  const lonPad = (lonExtent[1] - lonExtent[0]) * 0.08;
  const latPad = (latExtent[1] - latExtent[0]) * 0.08;
  const miniX = d3.scaleLinear().domain([lonExtent[0] - lonPad, lonExtent[1] + lonPad]).range([20, 218]);
  const miniY = d3.scaleLinear().domain([latExtent[0] - latPad, latExtent[1] + latPad]).range([174, 28]);
  function miniProject(coord) {
    return [miniX(coord[0]), miniY(coord[1])];
  }
  const miniLine = d3.line()
    .x((d) => miniProject(d)[0])
    .y((d) => miniProject(d)[1])
    .curve(d3.curveBasis);

  mini.selectAll(".mini-route")
    .data(routes.flatMap((route) =>
      Object.entries(route.directions).map(([dir, direction]) => ({ route, dir, direction }))
    ))
    .join("path")
    .attr("class", "mini-route")
    .attr("stroke", (d) => d.route.color)
    .attr("d", (d) => miniLine(d.direction.metric.coords));

  const miniBusLayer = mini.append("g");

  function updateHeader() {
    const hourAngle = ((state.busTime / 60) % 12) * 30;
    const minuteAngle = (state.busTime % 60) * 6;
    clockSvg.select(".hour-hand").attr("transform", `rotate(${hourAngle})`);
    clockSvg.select(".minute-hand").attr("transform", `rotate(${minuteAngle})`);
    clockSvg.select(".header-time").text(formatTime(state.busTime));

    const buses = routes.flatMap((route) => ["1", "2"].flatMap((dir) => activeBuses(route, dir, state.busTime).slice(0, 10)));
    miniBusLayer.selectAll(".mini-bus")
      .data(buses, (d, i) => `${d.route}-${d.dir}-${i}`)
      .join("circle")
      .attr("class", "mini-bus")
      .attr("r", 3)
      .attr("fill", (d) => colorByRoute.get(d.route))
      .attr("cx", (d) => miniProject(d.coord)[0])
      .attr("cy", (d) => miniProject(d.coord)[1]);
  }

  /* Leaflet base map with D3 overlay */
  const map = L.map("london-map", {
    zoomControl: false,
    scrollWheelZoom: false,
    attributionControl: true,
  }).setView([51.5074, -0.1278], 12);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);
  L.svg({ pane: "overlayPane" }).addTo(map);

  const overlaySvg = d3.select(map.getPanes().overlayPane).select("svg").classed("d3-map-overlay", true);
  const overlay = overlaySvg.select("g").classed("leaflet-zoom-hide", false);
  const routeLayer = overlay.append("g").attr("class", "route-layer");
  const stopLayer = overlay.append("g").attr("class", "stop-layer");
  const landmarkLayer = overlay.append("g").attr("class", "landmark-layer");
  const busLayer = overlay.append("g").attr("class", "bus-layer");
  const segmentLayer = overlay.append("g").attr("class", "segment-layer");

  function project(coord) {
    const point = map.latLngToLayerPoint(new L.LatLng(coord[1], coord[0]));
    return [point.x, point.y];
  }

  function projectStop(stop) {
    const point = map.latLngToLayerPoint(new L.LatLng(stop.lat, stop.lon));
    return [point.x, point.y];
  }

  const mapLine = d3.line()
    .x((d) => project(d)[0])
    .y((d) => project(d)[1])
    .curve(d3.curveBasis);

  function routePathData() {
    return routes.flatMap((route) =>
      Object.entries(route.directions).flatMap(([dir, direction]) =>
        direction.paths.map((path, index) => ({ route, dir, direction, path, index }))
      )
    );
  }

  function stopData() {
    return routes.flatMap((route) =>
      Object.entries(route.directions).flatMap(([dir, direction]) =>
        direction.stops.map((stop) => ({ ...stop, route: route.id, dir, color: route.color }))
      )
    );
  }

  function drawMap() {
    const paths = routeLayer.selectAll(".route-path.base")
      .data(routePathData(), (d) => `${d.route.id}-${d.dir}-${d.index}`);

    paths.join(
      (enter) => {
        enter.append("path")
          .attr("class", "route-path shadow")
          .attr("d", (d) => mapLine(d.path))
          .attr("stroke-width", 8);
        return enter.append("path")
          .attr("class", "route-path base")
          .attr("stroke", (d) => d.route.color)
          .attr("d", (d) => mapLine(d.path));
      },
      (update) => update.attr("d", (d) => mapLine(d.path)),
      (exit) => exit.remove()
    );

    routeLayer.selectAll(".route-path.shadow")
      .data(routePathData(), (d) => `${d.route.id}-${d.dir}-${d.index}`)
      .attr("d", (d) => mapLine(d.path));

    const stops = stopLayer.selectAll(".stop-dot")
      .data(stopData(), (d) => `${d.route}-${d.dir}-${d.index}`);

    stops.join("circle")
      .attr("class", (d) => {
        return `stop-dot${!routeIsActive(d.route) ? " inactive" : ""}`;
      })
      .attr("r", (d) => {
        const demand = getStopDemand(d.route, d.dir, d.index, state.busTime);
        const base = routeIsActive(d.route) ? 3.2 : 1.8;
        return base + Math.sqrt((demand ? demand.b + demand.a : 0) / Math.max(1, maxBoard)) * 8;
      })
      .attr("fill", "#fff")
      .attr("stroke", (d) => d.color)
      .attr("cx", (d) => projectStop(d)[0])
      .attr("cy", (d) => projectStop(d)[1])
      .on("pointerdown", (event, d) => {
        state.playing = false;
        if (state.activeRoute !== d.route) setRoute(d.route);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      })
      .on("pointerenter", (event, d) => {
        if (event.buttons && state.activeRoute !== d.route) {
          setRoute(d.route);
        }
      })
      .on("click", (_, d) => {
        state.playing = false;
        if (state.activeRoute !== d.route) setRoute(d.route);
      })
      .on("mousemove", (event, d) => {
        state.hoverStop = d;
        const demand = getStopDemand(d.route, d.dir, d.index, state.busTime);
        showTooltip(
          `<strong>${d.name}</strong><br>Route ${d.route} · ${d.dir === "1" ? "outbound" : "inbound"}<br>` +
          `${formatTime(state.busTime)} · board ${demand ? demand.b.toFixed(1) : "0"} · alight ${demand ? demand.a.toFixed(1) : "0"} · load ${demand ? demand.l.toFixed(1) : "0"}`,
          event
        );
      })
      .on("mouseleave", () => {
        state.hoverStop = null;
        hideTooltip();
      });

    const landmarks = landmarkLayer.selectAll(".landmark-group")
      .data(data.landmarks, (d) => d.id)
      .join("g")
      .attr("class", "landmark-group")
      .attr("transform", (d) => {
        const point = map.latLngToLayerPoint([d.lat, d.lon]);
        return `translate(${point.x},${point.y})`;
      });

    landmarks.selectAll(".landmark").data((d) => [d]).join("circle")
      .attr("class", "landmark")
      .attr("r", (d) => d.id === "big-ben" ? 5 : 3);

    landmarks.selectAll(".landmark-label").data((d) => [d]).join("text")
      .attr("class", "landmark-label")
      .attr("x", 7)
      .attr("y", 4)
      .text((d) => d.name);

    updateMap();
  }

  function updateMap() {
    routeLayer.selectAll(".route-path.base")
      .classed("dimmed", (d) => !routeIsActive(d.route.id))
      .attr("stroke-width", (d) => {
        const summary = summarizeRouteAt(d.route.id, state.busTime);
        const width = 2.1 + (summary.load / maxLoad) * 7;
        return routeIsActive(d.route.id) ? width + (isNetworkMode() ? 0.5 : 1.8) : Math.max(1.5, width * 0.55);
      })
      .attr("stroke-opacity", (d) => routeIsActive(d.route.id) ? (isNetworkMode() ? 0.62 : 0.82) : 0.3);

    const buses = routes.flatMap((route) =>
      ["1", "2"].flatMap((dir) => activeBuses(route, dir, state.busTime).slice(0, routeIsActive(route.id) ? (isNetworkMode() ? 11 : 22) : 8))
    );

    busLayer.selectAll(".bus-dot")
      .data(buses, (d, i) => `${d.route}-${d.dir}-${i}`)
      .join("circle")
      .attr("class", "bus-dot")
      .attr("r", (d) => routeIsActive(d.route) ? (isNetworkMode() ? 3.2 : 4.3) : 2.7)
      .attr("fill", (d) => colorByRoute.get(d.route))
      .attr("opacity", (d) => routeIsActive(d.route) ? (isNetworkMode() ? 0.72 : 0.95) : 0.42)
      .attr("cx", (d) => project(d.coord)[0])
      .attr("cy", (d) => project(d.coord)[1]);

    stopLayer.selectAll(".stop-dot")
      .attr("class", (d) => {
        return `stop-dot${!routeIsActive(d.route) ? " inactive" : ""}`;
      })
      .attr("r", (d) => {
        const demand = getStopDemand(d.route, d.dir, d.index, state.busTime);
        const base = routeIsActive(d.route) ? 3.2 : 1.8;
        return base + Math.sqrt((demand ? demand.b + demand.a : 0) / Math.max(1, maxBoard)) * 8;
      });

    segmentLayer.selectAll(".segment-line")
      .data([])
      .join("path")
      .attr("class", "segment-line")
      .attr("d", (d) => {
        const direction = routeById.get(d.route).directions[d.dir];
        const lo = Math.min(d.start, d.end);
        const hi = Math.max(d.start, d.end);
        const points = direction.stops.slice(lo, hi + 1).map((s) => [s.lon, s.lat]);
        return points.length > 1 ? mapLine(points) : null;
      });

    d3.select("#map-time-label").text(formatTime(state.busTime));
    d3.select("#focus-label").text(isNetworkMode() ? "All selected corridors" : `Route ${state.activeRoute}: ${routeById.get(state.activeRoute).name}`);
  }

  map.on("zoomend moveend", drawMap);
  drawMap();

  /* Marey diagram */
  const mareyBox = { width: 520, height: 548, margin: { top: 20, right: 24, bottom: 74, left: 58 } };
  let mareyScales = null;

  function drawMarey() {
    const route = routeById.get(detailRouteId());
    const maxStops = isNetworkMode() ? 1 : d3.max(Object.values(route.directions), (direction) => direction.stops.length) - 1;
    const width = mareyBox.width - mareyBox.margin.left - mareyBox.margin.right;
    const height = mareyBox.height - mareyBox.margin.top - mareyBox.margin.bottom;
    const x = d3.scaleLinear().domain([0, maxStops]).range([0, width]);
    const y = d3.scaleLinear().domain(timeRange).range([0, height]);
    mareyScales = { x, y, width, height };

    const svg = d3.select("#marey").html("").append("svg")
      .attr("viewBox", `0 0 ${mareyBox.width} ${mareyBox.height}`);
    const g = svg.append("g").attr("transform", `translate(${mareyBox.margin.left},${mareyBox.margin.top})`);

    g.append("g")
      .attr("class", "axis")
      .call(d3.axisLeft(y).tickValues(d3.range(5 * 60, 25 * 60, 120)).tickFormat(formatTime).tickSize(-width));

    const axisStops = isNetworkMode() ? [] : route.directions["1"].stops.filter((_, i) => i % 4 === 0 || i === route.directions["1"].stops.length - 1);
    g.append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${height})`)
      .call(isNetworkMode()
        ? d3.axisBottom(x).tickValues([0, 0.25, 0.5, 0.75, 1]).tickFormat((d) => `${Math.round(d * 100)}%`)
        : d3.axisBottom(x).tickValues(axisStops.map((d) => d.index)).tickFormat((i) => {
        const stop = route.directions["1"].stops.find((s) => s.index === i);
        return stop ? stop.name.split("/")[0].replace(" Station", "") : "";
      }))
      .selectAll("text")
      .attr("transform", "rotate(-34)")
      .attr("text-anchor", "end")
      .attr("dx", "-0.45em")
      .attr("dy", "0.25em");

    const line = d3.line()
      .x((d) => x(d[0]))
      .y((d) => y(d[1]))
      .curve(d3.curveLinear);

    const trips = isNetworkMode()
      ? routes.flatMap((networkRoute) => ["1", "2"].flatMap((dir) => {
        const direction = networkRoute.directions[dir];
        const denom = Math.max(1, direction.stops.length - 1);
        return direction.trips.filter((_, index) => index % 4 === 0).map((trip) => ({
          ...trip,
          route: networkRoute.id,
          dir,
          points: trip.points.map((point) => [point[0] / denom, point[1]]),
        }));
      }))
      : ["1", "2"].flatMap((dir) =>
        route.directions[dir].trips.map((trip) => ({ ...trip, dir, route: route.id }))
      );

    g.append("g")
      .selectAll(".marey-trip")
      .data(trips)
      .join("path")
      .attr("class", "marey-trip active-route")
      .attr("stroke", (d) => isNetworkMode() ? colorByRoute.get(d.route) : (d.dir === "1" ? route.color : "#5b5650"))
      .attr("stroke-opacity", isNetworkMode() ? 0.2 : null)
      .attr("stroke-width", isNetworkMode() ? 0.85 : null)
      .attr("stroke-dasharray", (d) => d.dir === "2" ? "3 3" : null)
      .attr("d", (d) => line(d.points));

    if (isNetworkMode()) {
      g.append("text")
        .attr("class", "axis-note")
        .attr("x", width)
        .attr("y", height + 48)
        .attr("text-anchor", "end")
        .text("all routes shown by progress along each route");
    }

    g.append("line")
      .attr("class", "time-cursor marey-cursor")
      .attr("x1", 0)
      .attr("x2", width);

    g.append("text")
      .attr("class", "time-label marey-time-label")
      .attr("x", width - 2)
      .attr("text-anchor", "end");

    svg.on("mousemove", (event) => {
      const pointer = d3.pointer(event, g.node());
      if (pointer[0] < 0 || pointer[0] > width || pointer[1] < 0 || pointer[1] > height) return;
      setBusTime(y.invert(pointer[1]), true);
    });

    updateMarey();
  }

  function updateMarey() {
    if (!mareyScales) return;
    const yPos = mareyScales.y(state.busTime);
    d3.select(".marey-cursor")
      .attr("y1", yPos)
      .attr("y2", yPos);
    d3.select(".marey-time-label")
      .attr("y", yPos - 5)
      .text(formatTime(state.busTime));
  }

  drawMarey();

  /* Passenger heatmap */
  const heatBox = { width: 850, rowHeight: 13, margin: { top: 24, right: 18, bottom: 36, left: 164 } };
  let heatScales = null;

  function drawHeatmap() {
    const route = routeById.get(passengerRouteId());
    const direction = route.directions["1"];
    const rows = direction.stops;
    const height = heatBox.margin.top + heatBox.margin.bottom + rows.length * heatBox.rowHeight;
    const width = heatBox.width - heatBox.margin.left - heatBox.margin.right;
    const x = d3.scaleBand().domain(timebands).range([0, width]).paddingInner(0.02);
    const y = d3.scaleBand().domain(rows.map((d) => d.index)).range([0, rows.length * heatBox.rowHeight]);
    const color = d3.scaleSequentialSqrt(d3.interpolateRgb("#fbfaf7", route.color)).domain([0, maxLoad * 0.9]);
    heatScales = { x, y, color };

    const cells = [];
    timebands.forEach((minute) => {
      const demand = getDemand(route.id, "1", minute);
      if (!demand) return;
      demand.stops.forEach((stop) => {
        cells.push({ minute, ...stop });
      });
    });

    const svg = d3.select("#stop-heatmap").html("").append("svg")
      .attr("viewBox", `0 0 ${heatBox.width} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${heatBox.margin.left},${heatBox.margin.top})`);

    g.append("g")
      .attr("class", "axis")
      .call(d3.axisTop(x).tickValues(timebands.filter((d) => d % 120 === 0)).tickFormat(formatTime).tickSize(-rows.length * heatBox.rowHeight));

    g.selectAll(".stop-label")
      .data(rows)
      .join("text")
      .attr("class", "stop-label")
      .attr("x", -8)
      .attr("y", (d) => y(d.index) + y.bandwidth() - 2)
      .attr("text-anchor", "end")
      .text((d) => d.name.length > 26 ? `${d.name.slice(0, 24)}...` : d.name);

    g.selectAll(".heat-cell")
      .data(cells)
      .join("rect")
      .attr("class", "heat-cell")
      .attr("x", (d) => x(d.minute))
      .attr("y", (d) => y(d.i))
      .attr("width", x.bandwidth())
      .attr("height", y.bandwidth())
      .attr("fill", (d) => color(d.l))
      .on("mousemove", (event, d) => {
        setPassengerTime(d.minute);
        const stop = direction.stops[d.i];
        state.passengerHoverStop = { ...stop, route: route.id, dir: "1" };
        showTooltip(
          `<strong>${stop ? stop.name : "Stop"}</strong><br>${formatTime(d.minute)} · load ${d.l.toFixed(1)}<br>` +
          `board ${d.b.toFixed(1)} · alight ${d.a.toFixed(1)} · V/C ${d.vc.toFixed(2)}`,
          event
        );
      })
      .on("mouseleave", hideTooltip);

    g.append("line")
      .attr("class", "time-cursor heat-cursor")
      .attr("y1", 0)
      .attr("y2", rows.length * heatBox.rowHeight);

    updateHeatmap();
  }

  function updateHeatmap() {
    if (!heatScales) return;
    d3.select(".heat-cursor")
      .attr("x1", heatScales.x(nearestTime(state.passengerTime)) + heatScales.x.bandwidth() / 2)
      .attr("x2", heatScales.x(nearestTime(state.passengerTime)) + heatScales.x.bandwidth() / 2);

    const route = routeById.get(passengerRouteId());
    const summary = summarizeRouteAt(route.id, state.passengerTime);
    d3.select("#panel-time").text(formatTime(state.passengerTime));
    d3.select("#route-summary").html(`
      <div class="stat-row"><span>Passenger route</span><strong>${route.id}</strong></div>
      <div class="stat-row"><span>Current boardings</span><strong>${summary.board.toFixed(1)}</strong></div>
      <div class="stat-row"><span>Current alightings</span><strong>${summary.alight.toFixed(1)}</strong></div>
      <div class="stat-row"><span>Peak load now</span><strong>${summary.load.toFixed(1)}</strong></div>
      <div class="stat-row"><span>Peak V/C now</span><strong>${summary.vc.toFixed(2)}</strong></div>
    `);
    if (state.passengerHoverStop && state.passengerHoverStop.route === route.id) {
      const demand = getStopDemand(route.id, state.passengerHoverStop.dir, state.passengerHoverStop.index, state.passengerTime);
      d3.select("#selected-stop").html(`
        <p><strong>${state.passengerHoverStop.name}</strong></p>
        <p>Board ${demand ? demand.b.toFixed(1) : "0"} · alight ${demand ? demand.a.toFixed(1) : "0"} · load ${demand ? demand.l.toFixed(1) : "0"}</p>
      `);
    } else {
      d3.select("#selected-stop").html(`<p>${route.note}</p><p class="panel-note">Passenger route selection is independent from the crowding and ride panels.</p>`);
    }
  }

  drawHeatmap();

  /* Crowding bands */
  const bandBox = { width: 980, height: 220, margin: { top: 18, right: 18, bottom: 32, left: 70 } };
  let bandScales = null;
  const profileBox = { width: 780, height: 250, margin: { top: 22, right: 24, bottom: 34, left: 58 } };
  let profileScales = null;

  function drawCrowdingBands() {
    const width = bandBox.width - bandBox.margin.left - bandBox.margin.right;
    const height = bandBox.height - bandBox.margin.top - bandBox.margin.bottom;
    const x = d3.scaleBand().domain(timebands).range([0, width]).paddingInner(0.02);
    const y = d3.scaleBand().domain(routeIds).range([0, height]).padding(0.24);
    const color = d3.scaleSequential(d3.interpolateRgb("#f4f1e9", "#7f4339")).domain([0, maxVC]);
    bandScales = { x, y };

    const cells = [];
    routeIds.forEach((routeId) => {
      timebands.forEach((minute) => {
        cells.push({ route: routeId, minute, ...summarizeRouteAt(routeId, minute) });
      });
    });

    const svg = d3.select("#crowding-bands").html("").append("svg")
      .attr("viewBox", `0 0 ${bandBox.width} ${bandBox.height}`);
    const g = svg.append("g").attr("transform", `translate(${bandBox.margin.left},${bandBox.margin.top})`);

    g.append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickValues(timebands.filter((d) => d % 120 === 0)).tickFormat(formatTime).tickSize(4));

    g.selectAll(".band-label")
      .data(routes)
      .join("text")
      .attr("class", "band-label")
      .attr("x", -12)
      .attr("y", (d) => y(d.id) + y.bandwidth() / 2 + 4)
      .attr("text-anchor", "end")
      .text((d) => d.id);

    g.selectAll(".band-cell")
      .data(cells)
      .join("rect")
      .attr("class", "band-cell")
      .attr("x", (d) => x(d.minute))
      .attr("y", (d) => y(d.route))
      .attr("width", x.bandwidth())
      .attr("height", y.bandwidth())
      .attr("fill", (d) => color(d.vc))
      .on("mousemove", (event, d) => {
        state.crowdingRoute = d.route;
        setCrowdingTime(d.minute);
        showTooltip(
          `<strong>Route ${d.route}</strong><br>${formatTime(d.minute)} · peak V/C ${d.vc.toFixed(2)}<br>` +
          `load ${d.load.toFixed(1)} · board ${d.board.toFixed(1)}`,
          event
        );
      })
      .on("mouseleave", hideTooltip);

    g.append("line")
      .attr("class", "time-cursor band-cursor")
      .attr("y1", 0)
      .attr("y2", height);

    updateCrowdingBands();
  }

  function updateCrowdingBands() {
    if (!bandScales) return;
    const x = bandScales.x(nearestTime(state.crowdingTime)) + bandScales.x.bandwidth() / 2;
    d3.select(".band-cursor").attr("x1", x).attr("x2", x);
    d3.selectAll(".band-cell")
      .classed("ride-route", (d) => d.route === crowdingRouteId());
    d3.selectAll(".band-label")
      .classed("active", (d) => d.id === crowdingRouteId());
  }

  drawCrowdingBands();

  function crowdingProfileSeries(routeId) {
    return timebands.map((minute) => ({
      minute,
      ...summarizeRouteAt(routeId, minute),
    }));
  }

  function drawCrowdingProfile() {
    const width = profileBox.width - profileBox.margin.left - profileBox.margin.right;
    const height = profileBox.height - profileBox.margin.top - profileBox.margin.bottom;
    const x = d3.scaleLinear().domain(timeRange).range([0, width]);
    const y = d3.scaleLinear().domain([0, maxLoad * 0.72]).range([height, 0]).clamp(true);
    profileScales = { x, y, width, height };

    const svg = d3.select("#crowding-profile").html("").append("svg")
      .attr("viewBox", `0 0 ${profileBox.width} ${profileBox.height}`);
    const g = svg.append("g").attr("transform", `translate(${profileBox.margin.left},${profileBox.margin.top})`);

    g.append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickValues(d3.range(6 * 60, 25 * 60, 180)).tickFormat(formatTime));
    g.append("g")
      .attr("class", "axis")
      .call(d3.axisLeft(y).ticks(4).tickSize(-width));

    g.append("path")
      .attr("class", "crowding-profile-line");
    g.append("line")
      .attr("class", "time-cursor crowding-profile-cursor")
      .attr("y1", 0)
      .attr("y2", height);

    svg.on("mousemove", (event) => {
      const pointer = d3.pointer(event, g.node());
      if (pointer[0] < 0 || pointer[0] > width) return;
      setCrowdingTime(x.invert(pointer[0]));
    });

    updateCrowdingProfile();
  }

  function updateCrowdingProfile() {
    if (!profileScales) return;
    const routeId = crowdingRouteId();
    const route = routeById.get(routeId);
    const series = crowdingProfileSeries(routeId);
    const line = d3.line()
      .x((d) => profileScales.x(d.minute))
      .y((d) => profileScales.y(d.load))
      .curve(d3.curveMonotoneX);
    const current = summarizeRouteAt(routeId, state.crowdingTime);

    d3.select(".crowding-profile-line")
      .attr("stroke", route.color)
      .attr("d", line(series));
    d3.select(".crowding-profile-cursor")
      .attr("x1", profileScales.x(state.crowdingTime))
      .attr("x2", profileScales.x(state.crowdingTime));
    d3.select("#crowding-copy").html(`
      <p><strong>Route ${routeId}</strong> · ${route.name}</p>
      <div class="stat-row"><span>Selected time</span><strong>${formatTime(state.crowdingTime)}</strong></div>
      <div class="stat-row"><span>Peak load</span><strong>${current.load.toFixed(1)}</strong></div>
      <div class="stat-row"><span>Boardings</span><strong>${current.board.toFixed(1)}</strong></div>
      <div class="stat-row"><span>Alightings</span><strong>${current.alight.toFixed(1)}</strong></div>
      <div class="stat-row"><span>Peak V/C</span><strong>${current.vc.toFixed(2)}</strong></div>
      <p class="panel-note">This line is the selected route's crowding profile across the typical weekday.</p>
    `);
  }

  function updateCrowding() {
    updateCrowdingBands();
    updateCrowdingProfile();
  }

  drawCrowdingProfile();

  /* Scheduled ride explorer */
  const rideMapBox = { width: 390, height: 365, margin: { top: 28, right: 28, bottom: 42, left: 28 } };
  const commuteBox = { width: 780, height: 365, margin: { top: 30, right: 86, bottom: 38, left: 58 } };
  let commuteG = null;
  let commuteScales = null;
  let rideSelectorScales = null;

  function minuteText(value) {
    return Number.isFinite(value) ? `${Math.round(value)} min` : "—";
  }

  function cleanHeadway(value) {
    return Number.isFinite(value) && value > 0 && value < 180 ? value : null;
  }

  function quantile(values, q) {
    const clean = values.filter(Number.isFinite).sort(d3.ascending);
    return clean.length ? d3.quantile(clean, q) : null;
  }

  function defaultSelection(routeId = rideRouteId()) {
    const route = routeById.get(routeId) || routeById.get("24");
    const stops = route.directions["1"].stops;
    return {
      route: route.id,
      dir: "1",
      start: Math.floor(stops.length * 0.25),
      end: Math.floor(stops.length * 0.7),
    };
  }

  function normalizedSegment(selection) {
    if (!selection) return null;
    const route = routeById.get(selection.route);
    if (!route) return null;
    const direction = route.directions[selection.dir] || route.directions["1"];
    const maxIndex = direction.stops.length - 1;
    const start = Math.max(0, Math.min(maxIndex, Math.min(selection.start, selection.end)));
    const end = Math.max(0, Math.min(maxIndex, Math.max(selection.start, selection.end)));
    if (start === end) return null;
    return { route: route.id, dir: selection.dir, start, end };
  }

  function timeAtStop(trip, stopIndex) {
    return completeTripTimes(trip)[stopIndex] ?? null;
  }

  function completeTripTimes(trip) {
    if (trip.completeTimes) return trip.completeTimes;
    const points = [...trip.points].sort((a, b) => a[0] - b[0]);
    const maxIndex = d3.max(points, (point) => point[0]) || 0;
    const times = [];
    points.forEach((point) => {
      times[point[0]] = point[1];
    });

    if (Number.isFinite(trip.depart)) {
      times[0] = trip.depart;
    }

    const anchors = [];
    times.forEach((time, index) => {
      if (Number.isFinite(time)) anchors.push([index, time]);
    });
    anchors.sort((a, b) => a[0] - b[0]);

    if (!anchors.length) {
      trip.completeTimes = times;
      return times;
    }

    for (let i = 0; i < anchors.length - 1; i += 1) {
      const [aIndex, aTime] = anchors[i];
      const [bIndex, bTime] = anchors[i + 1];
      const span = Math.max(1, bIndex - aIndex);
      const duration = Math.max(0.35 * span, bTime - aTime);
      for (let stopIndex = aIndex + 1; stopIndex < bIndex; stopIndex += 1) {
        times[stopIndex] = aTime + duration * ((stopIndex - aIndex) / span);
      }
    }

    const first = anchors[0];
    for (let stopIndex = first[0] - 1; stopIndex >= 0; stopIndex -= 1) {
      times[stopIndex] = times[stopIndex + 1] - 0.7;
    }

    const last = anchors[anchors.length - 1];
    for (let stopIndex = last[0] + 1; stopIndex <= maxIndex; stopIndex += 1) {
      times[stopIndex] = times[stopIndex - 1] + 0.7;
    }

    for (let stopIndex = 1; stopIndex < times.length; stopIndex += 1) {
      if (!Number.isFinite(times[stopIndex])) {
        times[stopIndex] = Number.isFinite(times[stopIndex - 1]) ? times[stopIndex - 1] + 0.7 : null;
      } else if (Number.isFinite(times[stopIndex - 1]) && times[stopIndex] <= times[stopIndex - 1]) {
        times[stopIndex] = times[stopIndex - 1] + 0.35;
      }
    }

    trip.completeTimes = times;
    return times;
  }

  function scheduledRideTrips(selection) {
    const route = routeById.get(selection.route);
    const direction = route.directions[selection.dir];
    const trips = direction.trips
      .map((trip) => {
        const startTime = timeAtStop(trip, selection.start);
        const endTime = timeAtStop(trip, selection.end);
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return null;
        return {
          startTime,
          travel: endTime - startTime,
          route: selection.route,
          dir: selection.dir,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.startTime - b.startTime);

    trips.forEach((trip, index) => {
      trip.headway = index > 0 ? trip.startTime - trips[index - 1].startTime : null;
    });
    return trips;
  }

  function rollingRideStats(trips) {
    const windowMinutes = 60;
    return timebands.map((minute) => {
      const nearby = trips.filter((trip) => Math.abs(trip.startTime - minute) <= windowMinutes);
      const travelValues = nearby.map((trip) => trip.travel);
      const headwayValues = nearby.map((trip) => cleanHeadway(trip.headway)).filter(Number.isFinite);
      return {
        minute,
        travelLow: quantile(travelValues, 0.1),
        travelMedian: quantile(travelValues, 0.5),
        travelHigh: quantile(travelValues, 0.9),
        headwayLow: quantile(headwayValues, 0.1),
        headwayMedian: quantile(headwayValues, 0.5),
        headwayHigh: quantile(headwayValues, 0.9),
      };
    });
  }

  function segmentDemandAt(selection, minute = state.rideTime) {
    const demand = getDemand(selection.route, selection.dir, minute);
    const stops = demand ? demand.stops.filter((s) => s.i >= selection.start && s.i <= selection.end) : [];
    return {
      load: stops.length ? d3.mean(stops, (s) => s.l) : 0,
      board: d3.sum(stops, (s) => s.b),
      alight: d3.sum(stops, (s) => s.a),
      vc: stops.length ? d3.max(stops, (s) => s.vc) : 0,
    };
  }

  function nextRide(trips, minute = state.rideTime) {
    return trips.find((trip) => trip.startTime >= minute) || null;
  }

  function nearestRide(trips, minute) {
    return d3.least(trips, (trip) => Math.abs(trip.startTime - minute));
  }

  function clearRideChart(message) {
    if (!commuteG) return;
    commuteScales = null;
    commuteG.selectAll(".ride-band, .ride-line, .ride-dot, .commute-cursor").attr("display", "none");
    commuteG.selectAll(".axis-note").attr("display", "none");
    d3.select("#commute-copy").html(`<p>${message}</p>`);
  }

  function currentRideSelection() {
    if (!state.rideSelection || state.rideSelection.route !== rideRouteId()) {
      state.rideSelection = defaultSelection(rideRouteId());
    }
    return state.rideSelection;
  }

  function rideStopPoint(stop) {
    return [rideSelectorScales.x(stop.lon), rideSelectorScales.y(stop.lat)];
  }

  function drawRideSelector() {
    const route = routeById.get(rideRouteId());
    const direction = route.directions["1"];
    const coords = direction.paths.flat();
    const lonExtent = d3.extent(coords, (d) => d[0]);
    const latExtent = d3.extent(coords, (d) => d[1]);
    const lonPad = (lonExtent[1] - lonExtent[0]) * 0.12 || 0.01;
    const latPad = (latExtent[1] - latExtent[0]) * 0.12 || 0.01;
    const width = rideMapBox.width - rideMapBox.margin.left - rideMapBox.margin.right;
    const height = rideMapBox.height - rideMapBox.margin.top - rideMapBox.margin.bottom;
    const x = d3.scaleLinear().domain([lonExtent[0] - lonPad, lonExtent[1] + lonPad]).range([0, width]);
    const y = d3.scaleLinear().domain([latExtent[0] - latPad, latExtent[1] + latPad]).range([height, 0]);
    rideSelectorScales = { x, y, width, height };

    const svg = d3.select("#ride-route-map").html("").append("svg")
      .attr("viewBox", `0 0 ${rideMapBox.width} ${rideMapBox.height}`);
    const g = svg.append("g").attr("transform", `translate(${rideMapBox.margin.left},${rideMapBox.margin.top})`);
    const line = d3.line()
      .x((d) => x(d[0]))
      .y((d) => y(d[1]))
      .curve(d3.curveBasis);

    g.selectAll(".ride-route-path")
      .data(direction.paths)
      .join("path")
      .attr("class", "ride-route-path")
      .attr("stroke", route.color)
      .attr("d", line);

    g.append("path").attr("class", "ride-selected-segment");

    g.selectAll(".ride-stop")
      .data(direction.stops, (d) => d.index)
      .join("circle")
      .attr("class", "ride-stop")
      .attr("cx", (d) => rideStopPoint(d)[0])
      .attr("cy", (d) => rideStopPoint(d)[1])
      .attr("r", 4.2)
      .on("pointerdown", (event, d) => {
        state.rideDragging = true;
        state.rideSelection = { route: route.id, dir: "1", start: d.index, end: d.index };
        event.preventDefault();
        updateRide();
      })
      .on("pointerenter", (_, d) => {
        if (!state.rideDragging || !state.rideSelection || state.rideSelection.route !== route.id) return;
        state.rideSelection.end = d.index;
        updateRide();
      })
      .on("mousemove", (event, d) => {
        showTooltip(`<strong>${d.name}</strong><br>Route ${route.id}`, event);
      })
      .on("mouseleave", hideTooltip);

    svg.on("pointerup pointerleave", () => {
      state.rideDragging = false;
    });

    g.append("text")
      .attr("class", "ride-route-title")
      .attr("x", width / 2)
      .attr("y", height + 28)
      .attr("text-anchor", "middle")
      .text(`Route ${route.id}: ${route.name}`);

    updateRideSelector();
  }

  function updateRideSelector() {
    if (!rideSelectorScales) return;
    const route = routeById.get(rideRouteId());
    const direction = route.directions["1"];
    const selection = currentRideSelection();
    const lo = Math.min(selection.start, selection.end);
    const hi = Math.max(selection.start, selection.end);
    const segmentStops = direction.stops.slice(lo, hi + 1);
    const segmentLine = d3.line()
      .x((d) => rideStopPoint(d)[0])
      .y((d) => rideStopPoint(d)[1])
      .curve(d3.curveBasis);

    d3.select(".ride-selected-segment")
      .datum(segmentStops)
      .attr("stroke", route.color)
      .attr("d", segmentStops.length > 1 ? segmentLine : null);

    d3.selectAll(".ride-stop")
      .classed("selected", (d) => d.index === selection.start || d.index === selection.end)
      .classed("between", (d) => d.index > lo && d.index < hi);
  }

  function drawCommute() {
    const svg = d3.select("#ride-chart").html("").append("svg")
      .attr("viewBox", `0 0 ${commuteBox.width} ${commuteBox.height}`);
    const g = svg.append("g").attr("transform", `translate(${commuteBox.margin.left},${commuteBox.margin.top})`);
    commuteG = g;
    const width = commuteBox.width - commuteBox.margin.left - commuteBox.margin.right;
    const height = commuteBox.height - commuteBox.margin.top - commuteBox.margin.bottom;
    const x = d3.scaleLinear().domain(timeRange).range([0, width]);

    g.append("g").attr("class", "axis x-axis");
    g.append("g").attr("class", "axis y-axis");
    g.append("line").attr("class", "zero-line");
    g.append("path").attr("class", "ride-band travel-band");
    g.append("path").attr("class", "ride-band headway-band");
    g.append("path").attr("class", "ride-line travel-line");
    g.append("path").attr("class", "ride-line headway-line");
    g.append("g").attr("class", "travel-dots");
    g.append("g").attr("class", "headway-dots");
    g.append("line").attr("class", "time-cursor commute-cursor");
    g.append("text").attr("class", "axis-note travel-note");
    g.append("text").attr("class", "axis-note headway-note");
    g.append("text").attr("class", "axis-note chart-note")
      .attr("x", width)
      .attr("y", height + 30)
      .attr("text-anchor", "end")
      .text("each dot is one scheduled bus");

    svg.on("mousemove", (event) => {
      const pointer = d3.pointer(event, g.node());
      if (pointer[0] < 0 || pointer[0] > width || pointer[1] < 0 || pointer[1] > height) return;
      const minute = x.invert(pointer[0]);
      setRideTime(minute);
      const trip = commuteScales ? nearestRide(commuteScales.trips, minute) : null;
      if (trip) {
        showTooltip(
          `<strong>${formatTime(trip.startTime)}</strong><br>scheduled ride ${minuteText(trip.travel)}<br>` +
          `headway ${minuteText(cleanHeadway(trip.headway))}`,
          event
        );
      }
    }).on("mouseleave", hideTooltip);
    updateCommute();
  }

  function updateCommute() {
    if (!commuteG) return;
    const rawSelection = currentRideSelection();
    const selection = normalizedSegment(rawSelection);
    if (!selection) {
      clearRideChart("Choose a second stop on the same route to build a scheduled ride chart.");
      return;
    }

    const route = routeById.get(selection.route);
    const direction = route.directions[selection.dir];
    const start = direction.stops[selection.start];
    const end = direction.stops[selection.end];
    const trips = scheduledRideTrips(selection);
    if (!trips.length) {
      clearRideChart("Scheduled timetable points are unavailable for this stop pair.");
      return;
    }

    const width = commuteBox.width - commuteBox.margin.left - commuteBox.margin.right;
    const height = commuteBox.height - commuteBox.margin.top - commuteBox.margin.bottom;
    const x = d3.scaleLinear().domain(timeRange).range([0, width]);
    const travelValues = trips.map((trip) => trip.travel);
    const headwayValues = trips.map((trip) => cleanHeadway(trip.headway)).filter(Number.isFinite);
    const maxTravel = Math.max(12, (quantile(travelValues, 0.95) || 18) + 4);
    const maxHeadway = Math.max(8, (quantile(headwayValues, 0.95) || 10) + 3);
    const y = d3.scaleLinear().domain([-maxHeadway, maxTravel]).range([height, 0]).nice();
    const zeroY = y(0);
    const stats = rollingRideStats(trips);
    const color = route.color;
    commuteScales = { x, y, width, height, trips, selection };

    commuteG.selectAll(".ride-band, .ride-line, .ride-dot, .commute-cursor").attr("display", null);
    commuteG.selectAll(".axis-note").attr("display", null);

    commuteG.select(".x-axis")
      .attr("transform", `translate(0,${zeroY})`)
      .call(d3.axisBottom(x).tickValues(d3.range(6 * 60, 25 * 60, 180)).tickFormat(formatTime).tickSize(4));
    commuteG.select(".y-axis")
      .call(d3.axisLeft(y).ticks(6).tickFormat((d) => Math.abs(d)).tickSize(-width));
    commuteG.select(".zero-line")
      .attr("x1", 0)
      .attr("x2", width)
      .attr("y1", zeroY)
      .attr("y2", zeroY);

    const travelArea = d3.area()
      .defined((d) => d.travelLow != null && d.travelHigh != null)
      .x((d) => x(d.minute))
      .y0((d) => y(d.travelLow))
      .y1((d) => y(d.travelHigh))
      .curve(d3.curveBasis);
    const headwayArea = d3.area()
      .defined((d) => d.headwayLow != null && d.headwayHigh != null)
      .x((d) => x(d.minute))
      .y0((d) => y(-d.headwayLow))
      .y1((d) => y(-d.headwayHigh))
      .curve(d3.curveBasis);
    const travelLine = d3.line()
      .defined((d) => d.travelMedian != null)
      .x((d) => x(d.minute))
      .y((d) => y(d.travelMedian))
      .curve(d3.curveMonotoneX);
    const headwayLine = d3.line()
      .defined((d) => d.headwayMedian != null)
      .x((d) => x(d.minute))
      .y((d) => y(-d.headwayMedian))
      .curve(d3.curveMonotoneX);

    commuteG.select(".travel-band").datum(stats).attr("d", travelArea);
    commuteG.select(".headway-band").datum(stats).attr("d", headwayArea);
    commuteG.select(".travel-line").datum(stats).attr("stroke", "#2f4f5f").attr("d", travelLine);
    commuteG.select(".headway-line").datum(stats).attr("stroke", color).attr("d", headwayLine);
    commuteG.select(".travel-dots")
      .selectAll("circle")
      .data(trips, (d) => `${d.startTime}-${d.travel}`)
      .join("circle")
      .attr("class", "ride-dot travel-dot")
      .attr("cx", (d) => x(d.startTime))
      .attr("cy", (d) => y(d.travel))
      .attr("r", 1.7);
    commuteG.select(".headway-dots")
      .selectAll("circle")
      .data(trips.filter((d) => cleanHeadway(d.headway)), (d) => `${d.startTime}-${d.headway}`)
      .join("circle")
      .attr("class", "ride-dot headway-dot")
      .attr("cx", (d) => x(d.startTime))
      .attr("cy", (d) => y(-cleanHeadway(d.headway)))
      .attr("r", 1.7);
    commuteG.select(".commute-cursor")
      .attr("x1", x(state.rideTime))
      .attr("x2", x(state.rideTime))
      .attr("y1", 0)
      .attr("y2", height);
    commuteG.select(".travel-note")
      .attr("x", width + 10)
      .attr("y", y(maxTravel * 0.72))
      .text("ride time");
    commuteG.select(".headway-note")
      .attr("x", width + 10)
      .attr("y", y(-maxHeadway * 0.55))
      .text("headway");
    commuteG.select(".chart-note")
      .attr("x", width)
      .attr("y", height + 30);

    const current = segmentDemandAt(selection);
    const next = nextRide(trips, state.rideTime);
    const headway = next ? cleanHeadway(next.headway) : null;
    d3.select("#commute-copy").html(`
      <p><strong>Route ${selection.route}</strong> · ${start.name} to ${end.name}</p>
      <div class="stat-row"><span>Selected time</span><strong>${formatTime(state.rideTime)}</strong></div>
      <div class="stat-row"><span>Next scheduled bus</span><strong>${next ? formatTime(next.startTime) : "—"}</strong></div>
      <div class="stat-row"><span>Planned wait</span><strong>${next ? minuteText(Math.max(0, next.startTime - state.rideTime)) : "—"}</strong></div>
      <div class="stat-row"><span>Scheduled ride</span><strong>${next ? minuteText(next.travel) : "—"}</strong></div>
      <div class="stat-row"><span>Headway before bus</span><strong>${minuteText(headway)}</strong></div>
      <div class="stat-row"><span>Typical load now</span><strong>${current.load.toFixed(1)}</strong></div>
      <div class="stat-row"><span>Boardings in segment</span><strong>${current.board.toFixed(1)}</strong></div>
      <div class="stat-row"><span>Peak V/C in segment</span><strong>${current.vc.toFixed(2)}</strong></div>
      <p class="panel-note">Scheduled timetable from TfL; passenger load uses typical BUSTO quarter-hour demand.</p>
    `);
  }

  state.rideSelection = defaultSelection(state.rideRoute);
  drawRideSelector();
  drawCommute();

  function updateRide() {
    updateRideSelector();
    updateCommute();
  }

  function updateBuses() {
    updateHeader();
    updateMap();
    updateMarey();
    d3.select("#play-button").classed("active", !state.playing).text(state.playing ? "pause" : "play");
  }

  function updatePassenger() {
    updateHeatmap();
  }

  function updateAll() {
    updateBuses();
    updatePassenger();
    updateCrowdingBands();
    updateCrowdingProfile();
    updateCommute();
  }

  setInterval(() => {
    if (!state.playing) return;
    const next = state.busTime + 15;
    state.busTime = next > timeRange[1] ? timeRange[0] : next;
    updateBuses();
  }, 620);

  updateAll();
}());
