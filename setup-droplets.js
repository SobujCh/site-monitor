require('dotenv').config();
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const DO_API_KEY = process.env.DO_API_KEY;
const DATACENTERS = process.env.DATACENTERS ? process.env.DATACENTERS.split(',') : [];
const PROXY_USERNAME = process.env.PROXY_USERNAME || 'proxyuser';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || 'proxypass123';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const SSH_KEY_ID = process.env.SSH_KEY_ID || '';

if (!DO_API_KEY) {
    console.error('ERROR: DO_API_KEY is required in .env file');
    process.exit(1);
}

if (DATACENTERS.length === 0) {
    console.error('ERROR: DATACENTERS is required in .env file (comma-separated list)');
    process.exit(1);
}

// Digital Ocean API base URL
const DO_API_BASE = 'https://api.digitalocean.com/v2';

// Helper function to make API calls
async function doApiCall(method, endpoint, data = null) {
    try {
        const config = {
            method,
            url: `${DO_API_BASE}${endpoint}`,
            headers: {
                'Authorization': `Bearer ${DO_API_KEY}`,
                'Content-Type': 'application/json'
            }
        };
        if (data) {
            config.data = data;
        }
        const response = await axios(config);
        return response.data;
    } catch (error) {
        console.error(`API Error: ${error.response?.data?.message || error.message}`);
        throw error;
    }
}

// Wait for droplet to be active
async function waitForDroplet(dropletId) {
    console.log(`Waiting for droplet ${dropletId} to be active...`);
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes max
    
    while (attempts < maxAttempts) {
        const droplet = await doApiCall('GET', `/droplets/${dropletId}`);
        const status = droplet.droplet.status;
        
        if (status === 'active') {
            console.log(`Droplet ${dropletId} is now active`);
            return droplet.droplet;
        }
        
        if (status === 'error') {
            throw new Error(`Droplet ${dropletId} creation failed`);
        }
        
        process.stdout.write('.');
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
    }
    
    throw new Error(`Droplet ${dropletId} did not become active in time`);
}

// Wait for SSH to be ready
async function waitForSSH(ip, maxAttempts = 30) {
    console.log(`Waiting for SSH to be ready on ${ip}...`);
    for (let i = 0; i < maxAttempts; i++) {
        try {
            execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no root@${ip} 'echo "SSH ready"' 2>/dev/null`, { stdio: 'ignore' });
            console.log(`SSH is ready on ${ip}`);
            return true;
        } catch (error) {
            process.stdout.write('.');
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    throw new Error(`SSH not ready on ${ip} after ${maxAttempts} attempts`);
}

// Execute command on remote server via SSH
function sshExec(ip, command) {
    try {
        // Escape single quotes in command
        const escapedCommand = command.replace(/'/g, "'\"'\"'");
        const result = execSync(
            `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 root@${ip} '${escapedCommand}'`,
            { encoding: 'utf-8', stdio: 'pipe', timeout: 600000, maxBuffer: 10 * 1024 * 1024 }
        );
        return { success: true, output: result };
    } catch (error) {
        const errorOutput = error.stdout || error.stderr || error.message;
        console.error(`SSH command failed: ${errorOutput.substring(0, 500)}`);
        return { success: false, output: errorOutput };
    }
}

// Get IPv6 addresses from droplet
async function getIPv6Addresses(ip) {
    console.log('Getting IPv6 addresses...');
    const result = sshExec(ip, 'ip -6 addr show | grep -E "inet6 2[0-9a-f][0-9a-f][0-9a-f]:" | awk \'{print $2}\' | cut -d\'/\' -f1');
    
    if (!result.success) {
        throw new Error(`Failed to get IPv6 addresses: ${result.output}`);
    }
    
    const addresses = result.output.trim().split('\n').filter(addr => addr.length > 0);
    console.log(`Found ${addresses.length} IPv6 addresses`);
    return addresses.slice(0, 16); // Limit to 16
}

// Setup 3proxy on droplet
async function setup3proxy(ip, ipv6Addresses) {
    console.log('Setting up 3proxy...');
    
    // Build proxy entries as a string
    const proxyEntries = ipv6Addresses.map((addr, index) => {
        const port = 10000 + index;
        return `proxy -6 -a -p${port} -i${addr}`;
    }).join('\n');
    
    // Escape variables for shell script (escape single quotes)
    const proxyUser = PROXY_USERNAME.replace(/'/g, "'\"'\"'");
    const proxyPass = PROXY_PASSWORD.replace(/'/g, "'\"'\"'");
    
    const setupScript = `
set -e
cd /tmp

# Install dependencies
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y build-essential curl wget git iproute2 net-tools make gcc g++ libc6-dev

# Install 3proxy
if [ ! -d "3proxy" ]; then
    git clone https://github.com/z3APA3A/3proxy.git
fi
cd 3proxy
make -f Makefile.Linux
mkdir -p /usr/local/3proxy/{bin,logs,conf}
cp bin/3proxy /usr/local/3proxy/bin/
chmod +x /usr/local/3proxy/bin/3proxy
chmod 755 /usr/local/3proxy/logs

# Generate 3proxy configuration
cat > /usr/local/3proxy/conf/3proxy.cfg <<CONFIGEOF
auth strong
users ${proxyUser}:CL:${proxyPass}
allow ${proxyUser}

log
logformat "- %U %C:%c %R:%r %O %I %h %T"
rotate 30
pidfile /usr/local/3proxy/logs/3proxy.pid

${proxyEntries}
CONFIGEOF

# Create systemd service
cat > /etc/systemd/system/3proxy.service <<'SERVICEEOF'
[Unit]
Description=3proxy Proxy Server
After=network.target

[Service]
Type=forking
ExecStart=/usr/local/3proxy/bin/3proxy /usr/local/3proxy/conf/3proxy.cfg
ExecStop=/bin/kill -TERM $(cat /usr/local/3proxy/logs/3proxy.pid 2>/dev/null) || true
PIDFile=/usr/local/3proxy/logs/3proxy.pid
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICEEOF

# Enable and start 3proxy
systemctl daemon-reload
systemctl enable 3proxy
systemctl start 3proxy

echo "3proxy setup complete"
`;
    
    const result = sshExec(ip, setupScript);
    if (!result.success) {
        throw new Error(`Failed to setup 3proxy: ${result.output}`);
    }
    console.log('3proxy setup complete');
}

// Setup PM2 and GitHub repo
async function setupPM2(ip, githubRepo) {
    console.log('Setting up PM2 and GitHub repo...');
    
    if (!githubRepo) {
        console.log('No GitHub repo specified, skipping PM2 setup');
        return;
    }
    
    const setupScript = `
set -e

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs

# Install PM2
npm install -g pm2

# Create app directory
APP_DIR="/opt/iv-monitor"
mkdir -p $APP_DIR
cd $APP_DIR

# Clone GitHub repo
if [ -d ".git" ]; then
    git pull
else
    git clone ${githubRepo} .
fi

# Install dependencies if package.json exists
if [ -f "package.json" ]; then
    npm install
fi

# Setup PM2 startup
pm2 startup systemd -u root --hp /root || true

# Start with PM2 if ecosystem.config.js exists, otherwise start app.js
if [ -f "ecosystem.config.js" ]; then
    pm2 start ecosystem.config.js
elif [ -f "app.js" ]; then
    pm2 start app.js --name iv-monitor
fi

pm2 save

echo "PM2 setup complete"
`;
    
    const result = sshExec(ip, setupScript);
    if (!result.success) {
        throw new Error(`Failed to setup PM2: ${result.output}`);
    }
    console.log('PM2 setup complete');
}

// Main function to setup a droplet
async function setupDroplet(datacenter) {
    console.log(`\n=== Setting up droplet in ${datacenter} ===`);
    
    try {
        // Step 1: Create droplet
        console.log('Step 1: Creating droplet...');
        const dropletData = {
            name: `iv-monitor-${datacenter}-${Date.now()}`,
            region: datacenter.trim(),
            size: 's-1vcpu-1gb',
            image: 'debian-12-x64',
            ipv6: true,
            ssh_keys: SSH_KEY_ID ? [parseInt(SSH_KEY_ID)] : []
        };
        
        const createResponse = await doApiCall('POST', '/droplets', dropletData);
        const dropletId = createResponse.droplet.id;
        console.log(`Droplet created with ID: ${dropletId}`);
        
        // Step 2: Wait for droplet to be active
        const droplet = await waitForDroplet(dropletId);
        const ipv4 = droplet.networks.v4.find(n => n.type === 'public')?.ip_address;
        
        if (!ipv4) {
            throw new Error('No IPv4 address found for droplet');
        }
        
        console.log(`Droplet IP: ${ipv4}`);
        
        // Step 3: Wait for SSH
        await waitForSSH(ipv4);
        
        // Step 4: Get IPv6 addresses
        const ipv6Addresses = await getIPv6Addresses(ipv4);
        
        if (ipv6Addresses.length === 0) {
            throw new Error('No IPv6 addresses found');
        }
        
        console.log(`Found ${ipv6Addresses.length} IPv6 addresses`);
        
        // Step 5: Setup 3proxy
        await setup3proxy(ipv4, ipv6Addresses);
        
        // Step 6: Setup PM2 and GitHub repo
        await setupPM2(ipv4, GITHUB_REPO);
        
        // Save credentials
        const credentials = {
            datacenter,
            droplet_id: dropletId,
            ipv4,
            ipv6_addresses: ipv6Addresses,
            proxy_username: PROXY_USERNAME,
            proxy_password: PROXY_PASSWORD,
            endpoints: ipv6Addresses.map((addr, index) => ({
                ip: addr,
                port: 10000 + index
            }))
        };
        
        const outputFile = `droplet-${datacenter}-${dropletId}.json`;
        fs.writeFileSync(outputFile, JSON.stringify(credentials, null, 2));
        console.log(`Credentials saved to ${outputFile}`);
        
        console.log(`\n✓ Droplet setup complete in ${datacenter}`);
        return credentials;
        
    } catch (error) {
        console.error(`\n✗ Error setting up droplet in ${datacenter}: ${error.message}`);
        throw error;
    }
}

// Main execution
async function main() {
    console.log('Starting droplet setup process...');
    console.log(`Datacenters: ${DATACENTERS.join(', ')}`);
    console.log(`GitHub Repo: ${GITHUB_REPO || 'Not specified'}`);
    
    const results = [];
    
    for (const datacenter of DATACENTERS) {
        try {
            const result = await setupDroplet(datacenter);
            results.push(result);
        } catch (error) {
            console.error(`Failed to setup droplet in ${datacenter}: ${error.message}`);
            // Continue with next datacenter
        }
    }
    
    console.log('\n=== Setup Summary ===');
    console.log(`Successfully setup ${results.length} out of ${DATACENTERS.length} droplets`);
    
    if (results.length > 0) {
        console.log('\nDroplet Details:');
        results.forEach(result => {
            console.log(`\n${result.datacenter}:`);
            console.log(`  Droplet ID: ${result.droplet_id}`);
            console.log(`  IPv4: ${result.ipv4}`);
            console.log(`  IPv6 Count: ${result.ipv6_addresses.length}`);
            console.log(`  Proxy: ${result.proxy_username}:${result.proxy_password}`);
        });
    }
}

// Run the script
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
