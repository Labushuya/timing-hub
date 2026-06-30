# Timing Bridge — Technical Reference

The timing bridge is a single Go binary that connects hardware timing devices to the Timing Hub cloud via WebSocket. It runs on the Zeitnehmer's laptop at the event venue.

---

## Supported Devices

| Device | Connection | Config type |
|---|---|---|
| ALGE Timy 3 | USB (VID `0x0c4a` / PID `0x0889`) | `alge_timy` |
| TAG Heuer CP 450 / 500 / 520 / 525 / 540 | RS-232 / USB-Serial | `tag_heuer_cp` |
| Trentmann RallyStar | RS-232 / USB-Serial | `trentmann_rallystar` |

---

## Configuration

Copy `bridge.toml.example` to `bridge.toml` and adjust to your device.

### ALGE Timy 3 (USB)

```toml
[device]
type = "alge_timy"
vendor_id = 0x0c4a
product_id = 0x0889
```

The Timy is auto-detected by USB vendor/product ID. No port configuration needed.

### TAG Heuer CP-Serie (RS-232 / USB-Serial)

```toml
[device]
type = "tag_heuer_cp"
serial_port = "COM3"     # Windows; use /dev/ttyUSB0 on Linux/Mac
baud_rate = 9600
data_bits = 8
stop_bits = 1
parity = "none"
```

### Trentmann RallyStar (RS-232 / USB-Serial)

```toml
[device]
type = "trentmann_rallystar"
serial_port = "COM4"     # Windows; use /dev/ttyUSB0 on Linux/Mac
baud_rate = 9600
data_bits = 8
stop_bits = 1
parity = "none"
```

### Auto-detection

```toml
[device]
type = "auto"
vendor_id = 0x0c4a
product_id = 0x0889
```

`auto` tries USB (ALGE Timy) first, then falls back to serial port detection. Useful as a safe default when device type varies between events.

---

## How to Find the COM Port

### Windows

1. Open Device Manager (`devmgmt.msc`)
2. Expand **Anschlüsse (COM und LPT)**
3. Locate your USB-Serial adapter (e.g. "USB Serial Port (COM3)")
4. Use that port name in `serial_port = "COM3"`

Alternatively from PowerShell:
```powershell
Get-WmiObject Win32_SerialPort | Select-Object Name, DeviceID
```

### Linux

```bash
ls /dev/ttyUSB* /dev/ttyACM*
# or with more detail:
dmesg | grep tty | tail -20
```

Typical paths: `/dev/ttyUSB0`, `/dev/ttyUSB1`, `/dev/ttyACM0`

Ensure your user is in the `dialout` group:
```bash
sudo usermod -aG dialout $USER
# log out and back in for the change to take effect
```

### macOS

```bash
ls /dev/tty.usb*
# e.g. /dev/tty.usbserial-110, /dev/tty.usbmodem14101
```

---

## Running the Bridge

```bash
# With default config file (bridge.toml in current directory)
./timy-bridge

# With explicit config path
./timy-bridge --config /path/to/bridge.toml
```

The bridge exposes a local status API at `http://localhost:7272/status`.

The tray icon shows connection state:
- Green — connected to device and cloud
- Orange — device connected, cloud offline (buffering locally)
- Red — device not detected

---

## Troubleshooting

### Device not detected

**ALGE Timy (USB):**
- Check USB cable is firmly seated
- Verify the VID/PID matches: `lsusb` on Linux, or Device Manager on Windows
- Try a different USB port
- On Linux: check `dmesg | grep usb` for connection events

**Serial devices (TAG Heuer / Trentmann):**
- Confirm the COM port in Device Manager (Windows) or `/dev/tty*` (Linux/Mac)
- Verify the baud rate matches the device's DIP switch or menu setting (default: 9600)
- Check cable: RS-232 null-modem cables and straight-through cables are not interchangeable
- On Linux: ensure user is in the `dialout` group (see above)

### Wrong baud rate

The device will connect but output will be garbled or empty. Check the device's own settings:
- TAG Heuer CP: accessible via the front panel menu
- Trentmann RallyStar: DIP switches on the device (refer to device manual)

Default for both: 9600 baud, 8 data bits, 1 stop bit, no parity (8N1).

### Bridge connects but no times appear in the browser

1. Check `http://localhost:7272/status` — is `device_connected` true?
2. Verify `bridge_token` and `posten_id` in `bridge.toml` match the values shown in the Timing Hub UI
3. Check firewall: the bridge needs outbound HTTPS/WSS on port 443 to `api.timinghub.de`

### Offline buffering

When the cloud connection drops, the bridge buffers impulses in a local SQLite file (`bridge-buffer.db` by default). The buffer path is configurable:

```toml
[reliability]
local_buffer_path = "./bridge-buffer.db"
max_buffer_entries = 10000
```

On reconnect, buffered entries are replayed in order. Do not delete the buffer file while the bridge is running.

---

## Adding a New Device Driver

Device drivers implement the `device.Driver` interface defined in `device/driver.go`:

```go
type Driver interface {
    // Open initialises the connection to the device.
    Open(cfg config.DeviceConfig) error

    // Read blocks until the next timing impulse arrives and returns it.
    // Returns io.EOF when the device is disconnected.
    Read() (Impulse, error)

    // Close releases all resources held by the driver.
    Close() error
}
```

### Steps

1. Create a new package under `device/` (e.g. `device/mydevice/mydevice.go`)
2. Implement `device.Driver`
3. Register the driver in `device/registry.go` by adding a case for the new type string
4. Add the type string to the `[device] type` comment in `bridge.toml.example`
5. Add a row to the Supported Devices table in this file and in `README.md`

### Impulse type

```go
type Impulse struct {
    // Absolute wall-clock time recorded by the device.
    // Format: HH:MM:SS.mmm — the server subtracts section start times.
    Time      time.Time
    // Channel identifies the trigger input on multi-channel devices.
    // Use 0 for single-channel devices.
    Channel   int
    // RawLine is the original unparsed line from the device for debugging.
    RawLine   string
}
```

### Testing a new driver

The bridge's local status API (`GET /status`) returns the last received impulse, which makes manual testing straightforward: trigger the device, then poll `http://localhost:7272/status` to verify the parsed timestamp.
