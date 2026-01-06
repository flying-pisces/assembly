# Seeed Studio reCamera

## Device Information

| Property | Value |
|----------|-------|
| **Device** | Seeed Studio reCamera (Cvitek NCM) |
| **USB Vendor ID** | 3346 |
| **USB Product ID** | 100c |
| **Manufacturer** | Cvitek |
| **Serial** | 0123456789 |

## Network Configuration

| Property | Value |
|----------|-------|
| **Network Interface** | enxb6fefc81f9fa |
| **Camera IP** | 192.168.42.1 |
| **Host PC IP** | 192.168.42.138/24 |
| **Connection Type** | USB NCM (Network Control Model) |

## Access Methods

- **SSH**: `ssh root@192.168.42.1`
- **Web Interface**: http://192.168.42.1
- **RTSP Stream**: rtsp://192.168.42.1:554/live

## USB Detection

```bash
# Verify device connection
lsusb | grep Cvitek

# Check network interface
ip addr show enxb6fefc81f9fa

# Test connectivity
ping 192.168.42.1
```
