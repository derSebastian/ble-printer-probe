# BLE Printer Probe

Identify your Bluetooth thermal printer and match it against known profiles.

---

## CLI

Requires Node.js 16+ and a machine with Bluetooth hardware.
Works on macOS, Linux, and Windows (via `@abandonware/noble`).

```bash
# Install
git clone https://github.com/derSebastian/ble-printer-probe
cd ble-printer-probe
npm install

# List known profiles
node cli.js --list

# Scan for all nearby BLE devices (20s)
node cli.js

# Identify a specific device
node cli.js PPS1

# Identify + test print
node cli.js PT210 --print

# Full interactive discovery (probing + capability tests + submission URL)
node cli.js PPS1 --discover

# Force-fetch latest profiles from remote
node cli.js --update-profiles
```

Output includes:

- Matched profile name and protocol details (or "unknown")
- Copyable JSON snippet for `config.json`
- Pre-filled GitHub issue URL for community sharing

---

## Profiles database

`profiles.json` is the community-maintained list of known printers.

| ID      | Name                                      | Protocol | Service UUID |
| ------- | ----------------------------------------- | -------- | ------------ |
| `pt210` | PT-210 (Bluetooth Thermal)                | ESC/POS  | `e7810a71-…` |
| `d1`    | D1 family (PPS1, QIRUI_Q3, LuckP_L3, D1X) | D1       | `0000ff00-…` |
| `gt01`  | GT01 cat-style thermal                    | GT01     | `0000ae30-…` |

### Adding a new printer

1. Run `node cli.js <YourDeviceName> --discover`
2. Answer the on-screen questions — the tool probes the printer automatically
3. Copy the GitHub issue URL printed at the end and submit it
4. Or open a PR that adds the entry directly to `profiles.json`

---
