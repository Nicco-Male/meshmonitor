# Nicco fork — MeshMonitor v4.14.0 integration

Integration branch: `agent/integrate-v4.14.0`

Upstream tag: `v4.14.0` (`96b310689697071552e13fa360ffe54c4565c37d`)

Local changes retained for validation:

- dashboard and map traceroute hop-to-hop rendering
- route-segment popups
- estimated markers and unique positions for unknown or unpositioned hops
- MQTT traceroute endpoint orientation
- node telemetry report and searchable picker
- telemetry range controls on empty datasets
- explicit empty-state messaging
- manual telemetry graph refresh

Manual validation checklist:

1. Build frontend and backend.
2. Open Dashboard and Map with traceroute layers enabled.
3. Check direct routes and routes containing real, unknown, and unpositioned hops.
4. Verify one estimated position per node ID and no fabricated direct segment across a hop.
5. Check MQTT traceroute source/destination orientation.
6. Open the node telemetry report and search by node name and ID.
7. Select an empty telemetry range and confirm controls remain visible.
8. Use the telemetry refresh control without returning to the application home screen.
9. Verify the v4.14.0 Node Details traceroute strip, statistical route view, and unified navigation.
10. Check logs for removed v1 root API endpoints returning 404.
