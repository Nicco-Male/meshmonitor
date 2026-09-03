# Multi-Source

::: tip New in 4.0 (expanded in 4.5+)
Multi-Source lets a single MeshMonitor deployment talk to **multiple meshes at once** — Meshtastic, MeshCore, and MQTT — side by side. Serial- and BLE-attached Meshtastic nodes reach MeshMonitor through the **Serial Bridge** or **BLE Bridge** sidecar (they present as a TCP endpoint). Everything that used to be a global setting (Virtual Node, auto-responder, auto-traceroute, scheduler, permissions) is now configured **per source**.
:::

![Dashboard with multiple sources in the sidebar](/images/features/dashboard-multi-source.png)

## What is a Source?

A **source** is one upstream connection MeshMonitor speaks to. Each source has:

- A **type** — `meshtastic_tcp`, `meshcore`, `mqtt_broker` (embedded MQTT broker hosting locally-connected clients), or `mqtt_bridge` (MQTT client to one upstream broker, optionally attached to a sibling `mqtt_broker` for fan-out — see [Embedded MQTT Broker & Bridge](/features/mqtt-broker)). Serial and BLE Meshtastic nodes connect through the Serial Bridge / BLE Bridge sidecars and appear as `meshtastic_tcp` sources pointing at the bridge container. MeshCore connects directly — USB or TCP through the UI. No sidecar either way.
- Its own **connection settings** (host, port, device path, credentials)
- Its own **scheduler** (auto-responder, auto-announce, auto-traceroute, auto-ack)
- Its own **Virtual Node** endpoint (TCP sources only)
- Its own **permissions** — which users can see/write to it

Sources are stored in the database and managed through the UI, not environment variables.

## Where do sources come from?

### Bootstrap (first run)

On first startup, MeshMonitor creates a single `meshtastic_tcp` source from these environment variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `MESHTASTIC_NODE_IP` | `192.168.1.100` | Hostname or IP of your node |
| `MESHTASTIC_TCP_PORT` | `4403` | TCP port |

After that first boot, **the env vars are informational only**. Changing them won't rename or reconfigure the existing source — use the UI instead. This keeps your single-node `docker-compose.yml` familiar while unlocking multi-node.

### Adding more sources

Open the **Sources sidebar** on the dashboard (admin only) to:

- **Add source** — click the **+** button next to the Sources header, choose a type, fill in connection details, save
- **Edit** — rename, re-host, re-port, toggle Virtual Node, or change other per-source settings
- **Enable / Disable** — pause an upstream connection without deleting it
- **Delete** — remove the connection and its source-scoped data

![Source options menu with Edit, Enable/Disable, and Delete actions](/images/features/sources-options-menu.png)

Changes that alter the upstream target (host, port, heartbeat) automatically restart the connection — no separate restart action is needed. The Sources sidebar is where *all* post-bootstrap connection changes happen.

### Arranging the sidebar

::: tip New in 4.9.3
:::

- **Reorder (Edit mode)** — click **Edit** next to **+ Add** (requires `sources:write`) to reveal drag handles, then drag source cards into the order you want. Click **Done** to hide the handles again. The order is saved server-side and shared across users.
- **Resize** — drag the sidebar's right edge to widen or narrow it; the chosen width is remembered per browser (200–480px). Useful for long MQTT source names.
- The per-source **node count** badge reflects each source's own nodes consistently, regardless of which source is currently selected.

## Source picker

Nearly every top-level view has a **source picker** in the header. It controls which source's data you're looking at:

- **Single-source mode** — pick one source; the view shows only that source's nodes, messages, telemetry, and traceroutes
- **Unified mode** (where available) — combines messages/telemetry/traceroutes across all sources while still tagging each row with its originating source

Your picker choice persists per view and per user.

## Sequential traceroute campaigns

The **Unified** dashboard can run a traceroute campaign against manually selected Meshtastic
nodes from a dedicated page. Open **Map Features → Traceroute campaign**, or open a node marker
and choose **Traceroute multi-source** to open the page in a new browser tab with that node already
selected. The Unified map remains available in the original tab while the campaign runs.

A campaign:

- uses only enabled, connected `meshtastic_tcp` sources selected on the page; MQTT and MeshCore
  sources are read-only or use a different path model and are not offered;
- sends exactly one traceroute at a time and waits for its response or timeout before using the
  next source;
- moves source/node pairs with a successful traceroute inside the configured recent-history
  window to the front, newest success first;
- can either continue through every source or stop attempts for a target node after its first
  success;
- shows live per-source results and can be cancelled while it is running;
- offers **Retry failed** when complete, creating a new sequential campaign containing only the
  source/node pairs that ended in timeout or error. Successful and skipped attempts are not sent
  again.

The default recent-history window is 24 hours, the response timeout is 75 seconds, and the pause
between attempts is 5 seconds. All three values can be changed before starting. When a selected
target is the local node of one source, only that source/target attempt is skipped.

Campaigns run in the server process and remain active when the operator returns to the map or
navigates elsewhere. Reopening the page resumes its live status. Only one campaign can run at a
time, preventing two operators from interleaving bursts across the same radios. The most recent
campaign state is kept in memory for live UI inspection; it is not retained across a MeshMonitor
restart.

For the lifetime of a campaign, each selected source is reserved for its campaign traceroutes.
Automatic traceroutes and Automation Engine traceroute actions on those sources skip their turn;
manual traceroute API requests receive HTTP `409` with code `TRACEROUTE_CAMPAIGN_ACTIVE`. Other
packet types and unselected sources continue to work normally. Reservations are released after
completion or cancellation.

The session API used by the Unified UI is:

```text
POST /api/traceroute-campaigns
GET  /api/traceroute-campaigns/active
GET  /api/traceroute-campaigns/latest
GET  /api/traceroute-campaigns/{campaignId}
POST /api/traceroute-campaigns/{campaignId}/retry
POST /api/traceroute-campaigns/{campaignId}/cancel
```

Starting a campaign requires `traceroute:write` permission on every selected source.
Retrying requires the same permission on every source represented by a failed attempt.

## Virtual Node

Virtual Node is a MeshMonitor feature that lets mobile Meshtastic apps connect *through* MeshMonitor instead of directly to the node. In 4.0 it is **per-source**.

- Only `meshtastic_tcp` sources support Virtual Node — MeshCore and MQTT sources ignore VN settings
- Each source can expose its own VN endpoint on its own port
- Ports must be unique across sources — the API rejects collisions with HTTP 409

### Enabling on a source

1. Open **Dashboard → Edit Source** on the TCP source you want to expose
2. Expand the **Virtual Node** section
3. Toggle it on
4. Choose a port (the previous global default was `4404`)
5. Decide whether to allow admin commands through the VN (reduces security — leave off unless you know you need it)
6. Save

![Edit Source dialog with Virtual Node section expanded](/images/features/edit-source-dialog.png)

Virtual Node config changes are hot-swapped without reconnecting the upstream TCP socket. Changing host/port still triggers a full reconnect.

### Docker port mapping

When you add a VN, publish the **in-container port** from your `docker-compose.yml`:

```yaml
services:
  meshmonitor:
    ports:
      - "8080:3001"        # Web UI
      - "4404:4404"        # Virtual Node for source A
      - "4405:4405"        # Virtual Node for source B (if you expose a second)
```

The [Docker Compose Configurator](/configurator) publishes one VN host port by default (`4404`). Match the VN port you choose in the UI to one of the published host ports.

::: warning Breaking change from 3.x
The old global env vars — `ENABLE_VIRTUAL_NODE`, `VIRTUAL_NODE_PORT`, `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS` — **were removed** and no longer have any effect. If you upgraded from 3.x, re-enable VN on each source you want to expose.
:::

## Per-Source Permissions

MeshMonitor's role-based access control treats sources as first-class resources. Admins can:

- Grant a user access to one or more sources
- Restrict read/write/admin actions per source
- Hide entire sources from users who shouldn't see them

Unauthorized endpoints return HTTP 403 — URL-hash route bypasses are blocked.

See [Per-Source Permissions](/features/per-source-permissions) for the full model.

## What else is per-source?

Everything that used to be a single global setting is now per-source:

| Feature | Per-source in 4.0 |
| --- | --- |
| Virtual Node | ✅ |
| Auto-Responder | ✅ |
| Auto-Announce | ✅ |
| Auto-Traceroute filter | ✅ |
| Auto-Ack | ✅ |
| Auto-Delete by Distance | ✅ |
| Auto-Favorite | ✅ |
| Scheduled Messages | ✅ |
| Permissions | ✅ |
| Notifications / Apprise | ✅ (admins and subscribers receive per-source events) |

For global behavior that isn't source-specific (theme, language, map center, push VAPID keys, session policy), use the new **Global Settings** page — accessible from the dashboard sidebar.

## Migration from 3.x

If you're upgrading from 3.x:

1. **Keep your env vars** — `MESHTASTIC_NODE_IP` / `MESHTASTIC_TCP_PORT` still seed the first source on a fresh install
2. **Drop removed VN env vars** — `ENABLE_VIRTUAL_NODE`, `VIRTUAL_NODE_PORT`, `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS` do nothing in 4.0
3. **Re-enable VN per source** — Dashboard → Edit Source → Virtual Node on each TCP source you want to expose
4. **Review permissions** — the per-source permission matrix may need admin review for non-admin users
5. **Back up first** — use System Backup from the Settings page before upgrading. The sources table is included.

## REST API

The v1 API reflects the per-source model directly. All mesh-data resources are scoped under `/api/v1/sources/{sourceId}/...`:

```
GET /api/v1/sources                              # list sources
GET /api/v1/sources/{sourceId}/nodes
GET /api/v1/sources/{sourceId}/messages
GET /api/v1/sources/{sourceId}/channels
GET /api/v1/sources/{sourceId}/telemetry
GET /api/v1/sources/{sourceId}/traceroutes
GET /api/v1/sources/{sourceId}/network
GET /api/v1/sources/{sourceId}/packets
GET /api/v1/sources/{sourceId}/status
```

Use `"default"` as `{sourceId}` to target the primary source. All v1 requests require `Authorization: Bearer mm_v1_...`. See the [API Reference](/development/api-reference) for complete documentation.

## Related

- [Per-Source Permissions](/features/per-source-permissions)
- [Store & Forward](/features/store-forward)
- [Auto-Responder](/developers/auto-responder-scripting)
- [Packet Monitor](/features/packet-monitor) — now source-aware
