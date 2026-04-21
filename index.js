import { 
    default as makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} from 'baileys';
import pino from 'pino';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';

const TELEGRAM_BOT_TOKEN = 'TOKEN_BOT_TELEGRAM_KAMU';
const TELEGRAM_CHAT_ID = 'ID_CHAT_ADMIN_TELEGRAM_KAMU'; 
const teleBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- STATE MANAGEMENT & CONFIG ---
const botState = {
    isConnecting: false,
    waitingForInput: false,
    jobQueue: new Map(),
    config: { batch: 25, delay: 7000 }
};

let sock; 
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- CORE WHATSAPP LOGIC ---
async function startWA(phoneNumberForPairing = null, chatId = null, messageId = null) {
    if (botState.isConnecting) return;
    botState.isConnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version, 
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        auth: state,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    // Request Pairing Code
    if (phoneNumberForPairing && !sock.authState.creds.registered) {
        await editOrSendMessage(chatId, messageId, `⏳ *Menghubungkan ke server Meta...*\nMeminta kode untuk nomor: \`+${phoneNumberForPairing}\``);
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                
                await editOrSendMessage(chatId, messageId, 
                    `✅ *KODE PAIRING ANDA:* \`${formattedCode}\`\n\n` +
                    `1️⃣ Buka WhatsApp di HP Anda\n` +
                    `2️⃣ Buka *Linked Devices* (Perangkat Tertaut)\n` +
                    `3️⃣ Pilih *Link with phone number instead*\n` +
                    `4️⃣ Masukkan kode di atas.\n\n` +
                    `_Sistem akan otomatis mendeteksi jika koneksi berhasil._`
                );
            } catch (error) {
                botState.isConnecting = false;
                await editOrSendMessage(chatId, messageId, `❌ *Gagal request kode!*\nPastikan format nomor benar (dengan kode negara) dan tidak terkena rate-limit Meta.\nError: ${error.message}`, getBackKeyboard());
            }
        }, 4000); 
    }

    // Connection Events
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            botState.isConnecting = false;
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log(`[!] Auto-Reconnect: Koneksi terputus (Status: ${statusCode}). Menyambungkan kembali dalam 5 detik...`);
                setTimeout(() => startWA(), 5000); 
            } else {
                if (fs.existsSync('./auth_info_baileys')) {
                    fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
                }
                sock = null;
                teleBot.sendMessage(TELEGRAM_CHAT_ID, "⚠️ *Koneksi WhatsApp Dikeluarkan!*\nSesi telah dihapus otomatis. Silakan login kembali melalui Dashboard.", { parse_mode: 'Markdown' });
                sendDashboard(TELEGRAM_CHAT_ID); 
            }
        } else if (connection === 'open') {
            botState.isConnecting = false;
            console.log('✅ WA Bot Ready!');
            if (chatId) {
                await sendDashboard(chatId, messageId);
            } else {
                teleBot.sendMessage(TELEGRAM_CHAT_ID, "✅ *WhatsApp Reconnected Successfully!*", { parse_mode: 'Markdown' });
            }
        }
    });
}

// --- TELEGRAM UI & DASHBOARD ---
async function editOrSendMessage(chatId, messageId, text, replyMarkup = null) {
    const opts = { parse_mode: 'Markdown' };
    if (replyMarkup) opts.reply_markup = replyMarkup;

    try {
        if (messageId) {
            await teleBot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
        } else {
            await teleBot.sendMessage(chatId, text, opts);
        }
    } catch (e) { /* Ignore identical edit error */ }
}

function getBackKeyboard() {
    return { inline_keyboard: [[{ text: '🔙 Kembali ke Dashboard', callback_data: 'nav_dashboard' }]] };
}

async function sendDashboard(chatId, messageId = null) {
    const isRegistered = fs.existsSync('./auth_info_baileys/creds.json');
    const statusIcon = isRegistered ? '🟢 TERHUBUNG' : '🔴 DISCONNECT';

    const text = `
⚡️ *GLOBAL WORKSPACE DASHBOARD* ⚡️
━━━━━━━━━━━━━━━━━━━━━━
📊 *System Status*
▪️ WhatsApp : ${statusIcon}
▪️ Batch Size: *${botState.config.batch}* nomor/request
▪️ Delay API : *${botState.config.delay / 1000}* detik

⚙️ *Panduan:*
Kirim dokumen \`.txt\` berisi daftar nomor target (Pastikan menyertakan kode negara, misal: 628x, 120x, 447x) ke obrolan ini untuk memulai *Bulk Check*.
━━━━━━━━━━━━━━━━━━━━━━`;

    const keyboard = {
        inline_keyboard: isRegistered ? [
            [{ text: '⚙️ Atur Limit & Batch', callback_data: 'menu_settings' }],
            [{ text: '🔄 Cek Status', callback_data: 'action_check' }, { text: '🛑 Logout', callback_data: 'action_logout' }]
        ] : [
            [{ text: '🔑 Login / Pairing WhatsApp', callback_data: 'action_login' }]
        ]
    };

    await editOrSendMessage(chatId, messageId, text, keyboard);
}

// --- TELEGRAM EVENT LISTENERS ---
console.log('⚡️ Memulai Engine Bot Telegram (Global Edition)...');
if (fs.existsSync('./auth_info_baileys/creds.json')) {
    console.log('Sesi ditemukan. Menghubungkan secara otomatis...');
    startWA(); 
} else {
    sendDashboard(TELEGRAM_CHAT_ID); 
}

teleBot.onText(/\/(start|menu|dashboard)/, (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    sendDashboard(msg.chat.id);
});

// Listener untuk input nomor HP (Support All Country Codes)
teleBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID || !msg.text || msg.text.startsWith('/')) return;
    
    if (botState.waitingForInput) {
        // Hapus semua karakter kecuali angka (seperti + atau spasi)
        const phoneNumber = msg.text.replace(/\D/g, ''); 
        botState.waitingForInput = false;

        // Validasi format internasional (biasanya 8 hingga 16 digit)
        if (!/^\d{8,16}$/.test(phoneNumber)) {
            const errKeyboard = { inline_keyboard: [[{ text: '🔄 Coba Lagi', callback_data: 'action_login' }], [{ text: '🔙 Batal', callback_data: 'nav_dashboard' }]] };
            return teleBot.sendMessage(msg.chat.id, "❌ *Validasi Gagal!*\nFormat nomor tidak valid. Pastikan panjang nomor sesuai standar dan diawali kode negara (contoh: 6281..., 120..., 447...).", { parse_mode: 'Markdown', reply_markup: errKeyboard });
        }

        const waitMsg = await teleBot.sendMessage(msg.chat.id, `⚙️ _Memproses permintaan login untuk_ \`+${phoneNumber}\`...`, { parse_mode: 'Markdown' });
        startWA(phoneNumber, msg.chat.id, waitMsg.message_id); 
    }
});

// Listener Dokumen TXT (Penyaring Nomor Internasional)
teleBot.on('document', async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    if (!sock?.authState?.creds?.registered) {
        return teleBot.sendMessage(msg.chat.id, '⚠️ *Akses Ditolak!*\nWhatsApp belum terhubung. Silakan login melalui /dashboard.');
    }

    if (!msg.document.file_name.endsWith('.txt')) {
        return teleBot.sendMessage(msg.chat.id, '❌ Sistem hanya membaca file berekstensi .txt');
    }

    try {
        const fileLink = await teleBot.getFileLink(msg.document.file_id);
        const response = await fetch(fileLink);
        const textData = await response.text();

        // Algoritma Parser Global
        // 1. Pecah per baris
        // 2. Bersihkan karakter non-digit (+, -, spasi, huruf)
        // 3. Buang nomor yang terlalu pendek atau terlalu panjang
        let rawNumbers = textData.split('\n')
            .map(n => n.replace(/\D/g, '')) 
            .filter(n => n.length >= 8 && n.length <= 16); 

        const uniqueNumbers = [...new Set(rawNumbers)];

        if (uniqueNumbers.length === 0) {
            return teleBot.sendMessage(msg.chat.id, '❌ *Data Kosong atau Tidak Valid!*\nPastikan file .txt berisi nomor beserta kode negara (tanpa tanda + tidak masalah, tapi wajib ada kode negara). Contoh:\n628123456789\n12015550123\n447911123456', { parse_mode: 'Markdown' });
        }

        const jobId = Date.now().toString();
        botState.jobQueue.set(jobId, uniqueNumbers);

        const text = `📁 *Dokumen Berhasil Dipindai*\n\nTerdeteksi *${uniqueNumbers.length}* nomor valid internasional.\nSistem akan menggunakan konfigurasi Anda saat ini (*${botState.config.batch} batch*).`;
        const keyboard = {
            inline_keyboard: [
                [{ text: '🚀 Mulai Pengecekan', callback_data: `start_${jobId}` }],
                [{ text: '⚙️ Ubah Batch', callback_data: 'menu_settings' }, { text: '🔙 Batal', callback_data: 'nav_dashboard' }]
            ]
        };

        teleBot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    } catch (error) {
        teleBot.sendMessage(msg.chat.id, `❌ Gagal memproses file: ${error.message}`);
    }
});

// Listener Callbacks (Tombol UI)
teleBot.on('callback_query', async (query) => {
    const { message, data, id } = query;
    const chatId = message.chat.id;
    const msgId = message.message_id;

    switch (true) {
        case data === 'nav_dashboard':
            botState.waitingForInput = false;
            await sendDashboard(chatId, msgId);
            break;

        case data === 'action_login':
            if (fs.existsSync('./auth_info_baileys/creds.json')) {
                return teleBot.answerCallbackQuery(id, { text: 'Akun WhatsApp sudah terhubung!', show_alert: true });
            }
            botState.waitingForInput = true;
            await editOrSendMessage(chatId, msgId, "📱 *Input Nomor WhatsApp*\n\nKirimkan nomor HP beserta *Kode Negara* yang terpasang di WhatsApp Anda ke obrolan ini.\n\n_Contoh Indonesia: 6281234567890_\n_Contoh US: 12015550123_\n\n*(Jangan gunakan tanda + atau spasi)*", getBackKeyboard());
            break;

        case data === 'action_check':
            const status = sock?.authState?.creds?.registered ? "Status: 🟢 Aktif & Terhubung" : "Status: 🔴 Terputus";
            teleBot.answerCallbackQuery(id, { text: status });
            break;

        case data === 'action_logout':
            if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
            sock = null;
            teleBot.answerCallbackQuery(id, { text: 'Sesi WhatsApp berhasil dihapus!', show_alert: true });
            await sendDashboard(chatId, msgId);
            break;

        case data === 'menu_settings':
            const setMenuText = `⚙️ *Pengaturan Batch & Delay*\n\nPilih jumlah pengecekan per sesi API. Semakin besar batch, proses makin cepat namun risiko banned makin tinggi.`;
            const setKeyboard = {
                inline_keyboard: [
                    [{ text: '10 Nomor (Aman)', callback_data: 'set_10' }, { text: '25 Nomor (Normal)', callback_data: 'set_25' }],
                    [{ text: '50 Nomor (Cepat)', callback_data: 'set_50' }, { text: '100 Nomor (Extreme)', callback_data: 'set_100' }],
                    [{ text: '🔙 Kembali', callback_data: 'nav_dashboard' }]
                ]
            };
            await editOrSendMessage(chatId, msgId, setMenuText, setKeyboard);
            break;

        case data.startsWith('set_'):
            const newBatch = parseInt(data.split('_')[1]);
            botState.config.batch = newBatch;
            botState.config.delay = newBatch === 10 ? 10000 : newBatch === 25 ? 7000 : newBatch === 50 ? 5000 : 3500;
            
            let alertMsg = `✅ Konfigurasi diubah ke Batch ${newBatch}`;
            let showAlert = false;

            if (newBatch >= 50) {
                alertMsg = `⚠️ PERINGATAN RISIKO TINGGI!\n\nBatch ${newBatch} nomor/request memiliki risiko tinggi rate-limit atau banned dari Meta. Gunakan dengan risiko Anda sendiri!`;
                showAlert = true;
            }

            await teleBot.answerCallbackQuery(id, { text: alertMsg, show_alert: showAlert });
            await sendDashboard(chatId, msgId);
            break;

        case data.startsWith('start_'):
            const jobId = data.split('_')[1];
            const numbersList = botState.jobQueue.get(jobId);

            if (!numbersList) {
                return teleBot.answerCallbackQuery(id, { text: '❌ Sesi file kadaluarsa. Silakan upload ulang.', show_alert: true });
            }

            await editOrSendMessage(chatId, msgId, `⏳ *Mengeksekusi Mesin Pengecekan...*\n⚙️ Config: *${botState.config.batch} Batch / ${botState.config.delay/1000}s Delay*\n📊 Total Data: *${numbersList.length}* nomor`);
            processBulkCheck(numbersList, botState.config, chatId, msgId);
            botState.jobQueue.delete(jobId);
            break;
    }
});

// --- CORE PROCESSING LOGIC ---
async function processBulkCheck(numbers, config, chatId, msgId) {
    let resultPersonal = "=== DATA NOMOR WA PERSONAL ===\n\n";
    let resultBisnis = "=== DATA NOMOR WA BISNIS ===\n\n";
    let resultTidakTerdaftar = "=== DATA NOMOR TIDAK TERDAFTAR ===\n\n";
    
    let countPersonal = 0, countBisnis = 0, countTidakTerdaftar = 0;
    const total = numbers.length;
    let processed = 0;

    for (let i = 0; i < total; i += config.batch) {
        const batchNumbers = numbers.slice(i, i + config.batch);
        
        const batchPromises = batchNumbers.map(async (num, index) => {
            await delay(index * 250); 
            // Otomatis menempelkan suffix internasional Meta
            const jid = `${num}@s.whatsapp.net`;
            let res = { num, isReg: false, isBiz: false, bio: '-', category: '-', dp: '-' };

            try {
                const [result] = await sock.onWhatsApp(jid);
                res.isReg = result?.exists || false;

                if (res.isReg) {
                    try { res.bio = (await sock.fetchStatus(jid))?.status || res.bio; } catch (e) {} 
                    try { res.dp = await sock.profilePictureUrl(jid, 'image') || res.dp; } catch (e) {}
                    try {
                        const biz = await sock.getBusinessProfile(jid);
                        if (biz) {
                            res.isBiz = true;
                            res.category = biz.category || res.category;
                        }
                    } catch (e) {}
                }
            } catch (error) {}
            return res;
        });

        const batchResults = await Promise.allSettled(batchPromises);
        
        batchResults.forEach(({ status, value: res }) => {
            if (status === 'fulfilled') {
                if (res.isReg) {
                    if (res.isBiz) {
                        resultBisnis += `Nomor    : +${res.num}\nBio      : ${res.bio}\nKategori : ${res.category}\n------------------------\n`;
                        countBisnis++;
                    } else {
                        resultPersonal += `Nomor    : +${res.num}\nBio      : ${res.bio}\n------------------------\n`;
                        countPersonal++;
                    }
                } else {
                    resultTidakTerdaftar += `+${res.num}\n`;
                    countTidakTerdaftar++;
                }
            }
        });

        processed += batchNumbers.length;
        const progressPercent = Math.round((processed / total) * 100);

        await editOrSendMessage(chatId, msgId, `⚙️ *Pemindaian Global Berlangsung...*\n\n⏳ Progress: ${processed}/${total} (*${progressPercent}%*)\n_Jeda pengamanan: ${config.delay/1000} detik_`).catch(() => {});
        if (processed < total) await delay(config.delay);
    }

    await editOrSendMessage(chatId, msgId, `✅ *TUGAS SELESAI!*\n\n📊 *Laporan Akhir:*\nTotal Diproses: ${total}\n\n👤 WA Personal: *${countPersonal}*\n🏢 WA Bisnis: *${countBisnis}*\n❌ Tidak Terdaftar: *${countTidakTerdaftar}*`, getBackKeyboard());

    if (countPersonal > 0) teleBot.sendDocument(chatId, Buffer.from(resultPersonal, 'utf-8'), {}, { filename: `WA_Personal_Global_${Date.now()}.txt` });
    if (countBisnis > 0) teleBot.sendDocument(chatId, Buffer.from(resultBisnis, 'utf-8'), {}, { filename: `WA_Bisnis_Global_${Date.now()}.txt` });
    if (countTidakTerdaftar > 0) teleBot.sendDocument(chatId, Buffer.from(resultTidakTerdaftar, 'utf-8'), {}, { filename: `WA_Mati_Global_${Date.now()}.txt` });
}
