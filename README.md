# IV Monitor - Automated Droplet Setup

This Node.js script automatically creates and configures Digital Ocean droplets with IPv6 support, 3proxy, and PM2.

## Overview

The script will:
1. **Create droplets** via Digital Ocean API for each datacenter specified
2. **Enable IPv6** on each droplet
3. **Discover IPv6 addresses** (up to 16 addresses per droplet)
4. **Setup 3proxy** with each IPv6 address on separate ports (10000-10015)
5. **Install PM2** and clone/run a GitHub repository

## Prerequisites

- Node.js (v14 or higher)
- Digital Ocean API key
- SSH access configured (SSH key ID or password)
- Git installed locally

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy the example environment file:

```bash
cp env.example .env
```

Edit `.env` and add your configuration:

```env
# Required
DO_API_KEY=your_digital_ocean_api_key_here
DATACENTERS=nyc1,sfo3,ams3

# Optional
SSH_KEY_ID=12345678
PROXY_USERNAME=proxyuser
PROXY_PASSWORD=proxypass123
GITHUB_REPO=https://github.com/username/repo.git
```

### 3. Get Your Digital Ocean API Key

1. Go to https://cloud.digitalocean.com/account/api/tokens
2. Click "Generate New Token"
3. Give it a name and select "Write" scope
4. Copy the token to your `.env` file

### 4. Get SSH Key ID (Optional but Recommended)

If you want to use SSH keys instead of password:

```bash
# Using doctl CLI
doctl compute ssh-key list

# Or via API
curl -X GET "https://api.digitalocean.com/v2/account/keys" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Copy the ID to `SSH_KEY_ID` in your `.env` file.

### 5. Run the Script

```bash
npm start
```

Or:

```bash
node setup-droplets.js
```

## Configuration Details

### Datacenters

Available Digital Ocean regions (comma-separated):
- `nyc1`, `nyc3` - New York
- `sfo3` - San Francisco
- `ams3` - Amsterdam
- `sgp1` - Singapore
- `lon1` - London
- `fra1` - Frankfurt
- `tor1` - Toronto
- `blr1` - Bangalore
- `syd1` - Sydney

Full list: https://docs.digitalocean.com/reference/api/api-reference/#tag/Regions

### Proxy Configuration

- **Username**: Set via `PROXY_USERNAME` (default: `proxyuser`)
- **Password**: Set via `PROXY_PASSWORD` (default: `proxypass123`)
- **Ports**: Each IPv6 address gets a port starting from 10000
  - First IPv6: port 10000
  - Second IPv6: port 10001
  - ... up to port 10015

### GitHub Repository

If you specify `GITHUB_REPO`, the script will:
1. Clone the repository to `/opt/iv-monitor`
2. Run `npm install` if `package.json` exists
3. Start with PM2 using `ecosystem.config.js` or `app.js`

## Output

For each successfully configured droplet, the script creates a JSON file with credentials:

```
droplet-nyc1-123456789.json
```

This file contains:
- Droplet ID and IP addresses
- All IPv6 addresses
- Proxy credentials
- Endpoint list with ports

Example output:
```json
{
  "datacenter": "nyc1",
  "droplet_id": 123456789,
  "ipv4": "123.45.67.89",
  "ipv6_addresses": [
    "2604:a880:400:d1::1234:5678",
    "2604:a880:400:d1::1234:5679",
    ...
  ],
  "proxy_username": "proxyuser",
  "proxy_password": "proxypass123",
  "endpoints": [
    {
      "ip": "2604:a880:400:d1::1234:5678",
      "port": 10000
    },
    ...
  ]
}
```

## Using the Proxies

After setup, you can use the proxies with any HTTP/HTTPS client:

```
Proxy: [IPv6_ADDRESS]:PORT
Username: proxyuser
Password: proxypass123
```

Example:
```
[2604:a880:400:d1::1234:5678]:10000
```

## Troubleshooting

### SSH Connection Issues

If SSH fails, make sure:
1. Your SSH key is added to Digital Ocean (if using `SSH_KEY_ID`)
2. Or password authentication is enabled
3. Wait a bit longer - droplets can take 1-2 minutes to be SSH-ready

### IPv6 Not Found

If no IPv6 addresses are found:
1. Ensure IPv6 is enabled when creating the droplet (it should be by default)
2. Wait a few minutes after droplet creation for IPv6 to be fully provisioned
3. Check manually: `ssh root@DROPLET_IP 'ip -6 addr show'`

### 3proxy Installation Fails

If 3proxy fails to compile:
1. Check that all dependencies are installed
2. Verify internet connectivity on the droplet
3. Check the SSH output for specific error messages

### PM2 Setup Issues

If PM2 setup fails:
1. Verify the GitHub repository URL is correct
2. Ensure the repository is public or you have access
3. Check that the repository has a valid `package.json` or `app.js`

## Manual Verification

SSH into a droplet and verify:

```bash
# Check 3proxy status
systemctl status 3proxy

# Check 3proxy configuration
cat /usr/local/3proxy/conf/3proxy.cfg

# Check PM2 status
pm2 status

# Check PM2 logs
pm2 logs
```

## Files

- `setup-droplets.js` - Main automation script
- `package.json` - Node.js dependencies
- `env.example` - Example environment configuration
- `.env` - Your actual configuration (not in git)
- `user-data.sh` - Original cloud-init script (alternative method)
- `app.js` - Placeholder Node.js application
- `ecosystem.config.js` - PM2 configuration

## Notes

- The script creates droplets with the smallest size (`s-1vcpu-1gb`) by default
- Each droplet gets up to 16 IPv6 addresses (depends on Digital Ocean allocation)
- Proxy credentials are the same across all droplets (as specified in `.env`)
- The script saves credentials to JSON files for easy reference
- SSH connections use `StrictHostKeyChecking=no` for automation

## License

ISC
# site-monitor
