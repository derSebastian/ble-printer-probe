# BLE Printer Probe

Identify your Bluetooth thermal printer and match it against known profiles.

Two ways to use it: a **web app** (no install) and a **CLI** (for power users or unsupported browsers).

---

## Web app — GitHub Pages

Open in Chrome, Edge, or Opera on desktop or Android:

> **[your-org.github.io/ble-printer-probe](https://your-org.github.io/ble-printer-probe)**

The page will:
1. Show you exactly what it's about to do
2. Ask the browser to open a Bluetooth device picker (you select your printer)
3. Connect, read the GATT service list, and match against known profiles
4. Give you a copyable JSON snippet for your `config.json`

**Browser support:** Chrome/Edge/Opera desktop, Chrome Android, Samsung Internet.
Not supported: Firefox (no Web Bluetooth), Safari (all platforms), any browser on iOS.

---

## CLI — for power users

Requires Node.js 16+ and a machine with Bluetooth hardware.
Works on macOS, Linux, and Windows (via `@abandonware/noble`).

```bash
# Install
git clone https://github.com/your-org/ble-printer-probe
cd ble-printer-probe
npm install

# List all known profiles
node cli.js --list

# Scan for all nearby BLE devices (20s)
node cli.js

# Connect to a specific device and identify it
node cli.js PPS1

# Identify and save an unknown device to profiles.json
node cli.js GT01 --save
```

Output includes:
- Matched profile name and protocol details (or "unknown")
- Copyable JSON snippet for `config.json`
- Pre-filled GitHub issue URL for community sharing

---

## Profiles database

`profiles.json` is the community-maintained list of known printers.

| ID | Name | Protocol | Service UUID |
|---|---|---|---|
| `pt210` | PT-210 (Bluetooth Thermal) | ESC/POS | `e7810a71-…` |
| `d1` | D1 family (PPS1, QIRUI_Q3, LuckP_L3, D1X) | D1 | `0000ff00-…` |
| `gt01` | GT01 cat-style thermal | GT01 | `0000ae30-…` |

### Adding a new printer

1. Run `node cli.js <YourDeviceName>` or use the web app
2. Copy the JSON output
3. [Open an issue](https://github.com/your-org/ble-printer-probe/issues/new) with the output
4. Or open a PR that adds the entry directly to `profiles.json`

---

## Part of the TaskPrinter project

[TaskPrinter](https://github.com/your-org/taskprinter) is a thermal printer task card app.
This tool is a standalone companion for identifying printers before configuring them.
