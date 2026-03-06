const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

let sock = null;
let qrCodeData = null;
let isConnected = false;
let connectionStatus = 'disconnected';

// Store auth state in a directory
const authDir = path.join(__dirname, 'auth_info');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['AdCampaign Hub', 'Chrome', '20.0.04'],
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'qr_ready';
            console.log('QR Code generated');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnect:', shouldReconnect);

            isConnected = false;
            connectionStatus = 'disconnected';
            qrCodeData = null;

            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connected successfully!');
            isConnected = true;
            connectionStatus = 'connected';
            qrCodeData = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Initialize WhatsApp connection
app.post('/initialize', async (req, res) => {
    try {
        if (sock && isConnected) {
            return res.json({ success: true, message: 'Already connected', status: 'connected' });
        }

        qrCodeData = null;
        connectionStatus = 'initializing';

        // Close existing socket if any to start fresh
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end();
            } catch (e) {
                console.log('Cleanup of old socket:', e.message);
            }
            sock = null;
        }

        await connectToWhatsApp();

        // Wait for QR code generation (max 10 seconds)
        let attempts = 0;
        while (!qrCodeData && attempts < 20 && connectionStatus !== 'connected') {
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }

        if (isConnected) {
            res.json({ success: true, message: 'Already authenticated', status: 'connected' });
        } else if (qrCodeData) {
            res.json({ success: true, message: 'QR code generated', status: 'qr_ready' });
        } else {
            // Stale auth is likely blocking QR generation - clear it and retry
            console.log('QR generation failed with existing auth. Clearing auth and retrying fresh...');

            if (sock) {
                try {
                    sock.ev.removeAllListeners();
                    sock.end();
                } catch (e) { }
                sock = null;
            }

            // Clear stale auth
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true });
                console.log('Cleared stale auth_info directory');
            }

            isConnected = false;
            connectionStatus = 'initializing';
            qrCodeData = null;

            // Retry with clean state
            await connectToWhatsApp();

            // Wait for QR code (max 15 seconds for fresh connection)
            let retryAttempts = 0;
            while (!qrCodeData && retryAttempts < 30 && connectionStatus !== 'connected') {
                await new Promise(resolve => setTimeout(resolve, 500));
                retryAttempts++;
            }

            if (isConnected) {
                res.json({ success: true, message: 'Connected after auth reset', status: 'connected' });
            } else if (qrCodeData) {
                res.json({ success: true, message: 'QR code generated after auth reset', status: 'qr_ready' });
            } else {
                res.status(500).json({ success: false, message: 'Failed to generate QR code. Please try again.' });
            }
        }
    } catch (error) {
        console.error('Initialize error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get QR code
app.get('/qr-code', (req, res) => {
    if (qrCodeData) {
        res.json({ success: true, qr: qrCodeData, status: 'qr_ready' });
    } else if (isConnected) {
        res.json({ success: true, status: 'connected', message: 'Already connected' });
    } else {
        res.json({ success: false, status: connectionStatus, message: 'No QR code available' });
    }
});

// Get connection status
app.get('/status', (req, res) => {
    res.json({
        success: true,
        connected: isConnected,
        status: connectionStatus
    });
});

// Get WhatsApp groups
app.get('/groups', async (req, res) => {
    try {
        if (!sock || !isConnected) {
            return res.status(400).json({ success: false, message: 'WhatsApp not connected' });
        }

        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(group => ({
            id: group.id,
            name: group.subject,
            participants: group.participants.length
        }));

        res.json({ success: true, groups: groupList });
    } catch (error) {
        console.error('Get groups error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Format phone number to WhatsApp format
function formatPhoneNumber(number) {
    // Remove all non-numeric characters
    let cleaned = number.replace(/\D/g, '');

    // If starts with 00, replace with +
    if (cleaned.startsWith('00')) {
        cleaned = cleaned.substring(2);
    }

    // Remove leading + if present
    cleaned = cleaned.replace(/^\+/, '');

    return cleaned + '@s.whatsapp.net';
}

// Publish message to WhatsApp
app.post('/publish', async (req, res) => {
    try {
        if (!sock || !isConnected) {
            return res.status(400).json({ success: false, message: 'WhatsApp not connected' });
        }

        const { mode, recipients, groupId, caption, mediaUrl, mediaType } = req.body;

        if (!mode || !caption) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        let results = [];

        // Send to multiple numbers
        if (mode === 'numbers' && recipients && recipients.length > 0) {
            for (const recipient of recipients) {
                try {
                    const formattedNumber = formatPhoneNumber(recipient);

                    if (mediaUrl) {
                        // Send media with caption
                        await sock.sendMessage(formattedNumber, {
                            [mediaType === 'video' ? 'video' : 'image']: { url: mediaUrl },
                            caption: caption
                        });
                    } else {
                        // Send text only
                        await sock.sendMessage(formattedNumber, { text: caption });
                    }

                    results.push({ recipient, success: true });
                } catch (error) {
                    console.error(`Error sending to ${recipient}:`, error);
                    results.push({ recipient, success: false, error: error.message });
                }
            }
        }

        // Send to group
        if (mode === 'group' && groupId) {
            try {
                if (mediaUrl) {
                    await sock.sendMessage(groupId, {
                        [mediaType === 'video' ? 'video' : 'image']: { url: mediaUrl },
                        caption: caption
                    });
                } else {
                    await sock.sendMessage(groupId, { text: caption });
                }
                results.push({ recipient: 'group', success: true });
            } catch (error) {
                console.error('Error sending to group:', error);
                results.push({ recipient: 'group', success: false, error: error.message });
            }
        }

        const allSuccess = results.every(r => r.success);
        res.json({
            success: allSuccess,
            message: allSuccess ? 'Messages sent successfully' : 'Some messages failed',
            results
        });

    } catch (error) {
        console.error('Publish error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Logout
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }

        // Delete auth files
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }

        isConnected = false;
        connectionStatus = 'disconnected';
        qrCodeData = null;
        sock = null;

        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 8002;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp service running on port ${PORT}`);
});

// Check if auth exists on startup - only auto-connect if auth files look valid
if (fs.existsSync(authDir)) {
    const authFiles = fs.readdirSync(authDir);
    const hasCredsFile = authFiles.some(f => f.includes('creds'));
    if (hasCredsFile) {
        console.log('Auth found, attempting auto-connect...');
        connectToWhatsApp().catch(err => {
            console.log('Auto-connect failed (stale auth?), will retry on /initialize:', err.message);
        });
    } else {
        console.log('Auth directory exists but no creds file - waiting for /initialize');
    }
} else {
    console.log('No auth found - waiting for /initialize');
}
