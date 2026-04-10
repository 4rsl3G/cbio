import { 
    default as makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} from 'baileys';
import pino from 'pino';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';

// === KONFIGURASI BOT ===
const TELEGRAM_BOT_TOKEN = 'TOKEN_BOT_TELEGRAM_KAMU';
const TELEGRAM_CHAT_ID = 'ID_CHAT_ADMIN_TELEGRAM_KAMU'; 
const teleBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Konfigurasi Kecepatan (Batch Size & Delay dalam milidetik)
const SPEED_MODES = {
    fast: { batch: 100, delay: 3000 },
    normal: { batch: 50, delay: 5000 },
    slow: { batch: 20, delay: 10000 }
};

// Memory sementara untuk antrean file bulk
const jobQueue = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let sock; 
let isConnecting = false; 

// === FUNGSI START WHATSAPP ===
async function startWA(phoneNumberForPairing = null) {
    if (isConnecting) return;
    isConnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        version: [2, 3000, 1015901307],
        printQRInTerminal: false,
        // Konfigurasi Browser Array untuk Bypass Blokir Perangkat
        browser: ['Ubuntu', 'Chrome', '20.0.04'], 
        auth: state,
        logger: pino({ level: 'silent' }) 
    });

    sock.ev.on('creds.update', saveCreds);

    // Proses Request Pairing Code
    if (phoneNumberForPairing && !sock.authState.creds.registered) {
        teleBot.sendMessage(TELEGRAM_CHAT_ID, `⏳ *Menghubungkan ke WA & Meminta Kode...*`, { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                teleBot.sendMessage(TELEGRAM_CHAT_ID, `✅ *KODE PAIRING ANDA:* \`${code}\`\n\n1️⃣ Buka WhatsApp Bot\n2️⃣ Titik tiga (Kanan Atas) -> *Linked Devices*\n3️⃣ *Link with phone number instead*\n4️⃣ Masukkan kode di atas.`, { parse_mode: 'Markdown' });
            } catch (error) {
                teleBot.sendMessage(TELEGRAM_CHAT_ID, `❌ *Gagal request kode:* ${error.message}\nPastikan format nomor benar (628xxx) dan belum kena limit cooldown.`, { parse_mode: 'Markdown' });
            }
        }, 2500); 
    }

    // Auto-Reconnect & Connection State Logic
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            isConnecting = false;
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log('Koneksi terputus. Auto-reconnecting dalam 5 detik...');
                setTimeout(() => startWA(), 5000); 
            } else {
                teleBot.sendMessage(TELEGRAM_CHAT_ID, "❌ *WhatsApp Logout/Dikeluarkan!*\nSesi telah dihapus. Silakan klik tombol Login WA lagi untuk menghubungkan ulang.", { parse_mode: 'Markdown' });
                fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
                sock = null;
                showTelegramMenu(); 
            }
        } else if (connection === 'open') {
            isConnecting = false;
            console.log('✅ WA Bot Ready!');
            teleBot.sendMessage(TELEGRAM_CHAT_ID, '✅ *WhatsApp Berhasil Terhubung!*\nMesin siap digunakan untuk Bulk Check.', { parse_mode: 'Markdown' });
        }
    });
}

// === TELEGRAM UI / MENU KONTROL ===
function showTelegramMenu() {
    const isRegistered = fs.existsSync('./auth_info_baileys/creds.json');
    
    if (isRegistered) {
        teleBot.sendMessage(TELEGRAM_CHAT_ID, "✅ *Status: WhatsApp Tersimpan di Database.*\nKirim file `.txt` berisi nomor target untuk memulai Bulk Check.", { parse_mode: 'Markdown' });
    } else {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔑 Login WhatsApp (Pairing)', callback_data: 'action_login_wa' }]
            ]
        };
        teleBot.sendMessage(TELEGRAM_CHAT_ID, "⚠️ *WhatsApp Belum Terhubung.*\nBot WhatsApp tidak akan menyala sebelum Anda melakukan login.\n\nKlik tombol di bawah ini untuk menghubungkan:", { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }
}

// === TELEGRAM HANDLER ===

console.log('Script Node.js berjalan. Mengecek status database...');
if (fs.existsSync('./auth_info_baileys/creds.json')) {
    console.log('Ditemukan sesi lama. Mencoba auto-connect...');
    startWA(); 
} else {
    console.log('Menunggu instruksi koneksi dari Telegram...');
    showTelegramMenu(); 
}

teleBot.onText(/\/(start|menu)/, (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    showTelegramMenu();
});

// Listener untuk memproses nomor telepon yang dibalas via Telegram
teleBot.on('message', (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    if (msg.reply_to_message && msg.reply_to_message.text.includes("Balas pesan ini dengan nomor WhatsApp")) {
        const phoneNumber = msg.text.replace(/\D/g, ''); 
        if (phoneNumber.length < 9 || !phoneNumber.startsWith('62')) {
            return teleBot.sendMessage(TELEGRAM_CHAT_ID, "❌ *Format nomor salah!* Harus diawali dengan 62 (contoh: 6281234...). Silakan ulangi tekan tombol Login.");
        }
        startWA(phoneNumber); 
    }
});

// Listener interaksi tombol Inline Keyboard
teleBot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;

    if (data === 'action_login_wa') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) {
            return teleBot.answerCallbackQuery(callbackQuery.id, { text: 'WhatsApp sudah terhubung!', show_alert: true });
        }
        
        teleBot.sendMessage(message.chat.id, "📱 *Masukkan Nomor WhatsApp*\n\nBalas pesan ini dengan nomor WhatsApp Bot yang ingin disambungkan.\n(Gunakan format *628xxx* tanpa spasi/tanda plus)", {
            parse_mode: 'Markdown',
            reply_markup: { force_reply: true } 
        });
        teleBot.answerCallbackQuery(callbackQuery.id);
    }

    else if (data.startsWith('start_')) {
        const [, jobId, mode] = data.split('_');
        const numbersList = jobQueue.get(jobId);

        if (!numbersList) {
            return teleBot.answerCallbackQuery(callbackQuery.id, { text: '❌ Sesi sudah kadaluarsa atau selesai.', show_alert: true });
        }

        const config = SPEED_MODES[mode];
        teleBot.editMessageText(`⏳ *Memulai Proses Cek Bulk...*\nMode: ${mode.toUpperCase()}\nTotal: ${numbersList.length} nomor`, {
            chat_id: message.chat.id,
            message_id: message.message_id,
            parse_mode: 'Markdown'
        });

        processBulkCheck(numbersList, config, message.chat.id, message.message_id);
        jobQueue.delete(jobId);
    }
});

// Listener untuk menerima file .txt target Bulk
teleBot.on('document', async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

    if (!sock?.authState?.creds?.registered) {
        return teleBot.sendMessage(msg.chat.id, '⚠️ *WhatsApp belum login!* Ketik /menu lalu tekan tombol Login WA terlebih dahulu.', { parse_mode: 'Markdown' });
    }

    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;
    
    if (!fileName.endsWith('.txt')) {
        return teleBot.sendMessage(msg.chat.id, '❌ Harap kirim file berekstensi .txt (Satu nomor per baris).');
    }

    try {
        const fileLink = await teleBot.getFileLink(fileId);
        const response = await fetch(fileLink);
        const textData = await response.text();

        let rawNumbers = textData.split('\n').map(n => n.replace(/\D/g, '')).filter(n => n.length > 8);
        const formattedNumbers = rawNumbers.map(n => {
            if (n.startsWith('0')) return '62' + n.slice(1);
            return n;
        });

        const uniqueNumbers = [...new Set(formattedNumbers)];

        if (uniqueNumbers.length === 0) {
            return teleBot.sendMessage(msg.chat.id, '❌ Tidak ada nomor valid yang ditemukan di dalam file txt.');
        }

        const jobId = Date.now().toString();
        jobQueue.set(jobId, uniqueNumbers);

        const keyboard = {
            inline_keyboard: [
                [{ text: '🚀 Fast (100/3s)', callback_data: `start_${jobId}_fast` }],
                [{ text: '🚗 Normal (50/5s)', callback_data: `start_${jobId}_normal` }],
                [{ text: '🚲 Slow (20/10s)', callback_data: `start_${jobId}_slow` }]
            ]
        };

        teleBot.sendMessage(msg.chat.id, `📁 *File TXT diterima!*\nTotal nomor unik: ${uniqueNumbers.length}\n\nPilih mode kecepatan:`, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

    } catch (error) {
        teleBot.sendMessage(msg.chat.id, `❌ Gagal memproses file: ${error.message}`);
    }
});

// === CORE LOGIC: BATCH PROCESSING & SPLIT RESULTS ===
async function processBulkCheck(numbers, config, chatId, msgId) {
    let resultPersonal = "=== DATA NOMOR WA PERSONAL TERDAFTAR ===\n\n";
    let resultBisnis = "=== DATA NOMOR WA BISNIS TERDAFTAR ===\n\n";
    let resultTidakTerdaftar = "=== DATA NOMOR TIDAK AKTIF/TIDAK TERDAFTAR ===\n\n";
    
    let countPersonal = 0;
    let countBisnis = 0;
    let countTidakTerdaftar = 0;

    const total = numbers.length;
    let processed = 0;

    for (let i = 0; i < total; i += config.batch) {
        const batchNumbers = numbers.slice(i, i + config.batch);
        
        const batchPromises = batchNumbers.map(async (num) => {
            const jid = `${num}@s.whatsapp.net`;
            let isRegistered = false;
            let isBusiness = false;
            let bio = 'Tidak diketahui / Diprivasi';
            let bizDesc = 'Tidak ada deskripsi';
            let bizCategory = 'Tidak diketahui';

            try {
                const [result] = await sock.onWhatsApp(jid);
                isRegistered = result?.exists || false;

                if (isRegistered) {
                    try {
                        const statusData = await sock.fetchStatus(jid);
                        bio = statusData?.status || bio;
                    } catch (e) {} 

                    try {
                        const bizProfile = await sock.getBusinessProfile(jid);
                        if (bizProfile) {
                            isBusiness = true;
                            bizDesc = bizProfile.description || bizDesc;
                            bizCategory = bizProfile.category || bizCategory;
                        }
                    } catch (e) {}
                }
            } catch (error) {}

            return { num, isRegistered, isBusiness, bio, bizDesc, bizCategory };
        });

        const batchResults = await Promise.allSettled(batchPromises);
        
        batchResults.forEach(res => {
            if (res.status === 'fulfilled') {
                const { num, isRegistered, isBusiness, bio, bizDesc, bizCategory } = res.value;
                
                if (isRegistered) {
                    if (isBusiness) {
                        resultBisnis += `Nomor      : ${num}\nBio        : ${bio}\nKategori   : ${bizCategory}\nDeskripsi  : ${bizDesc}\n----------------------------------------\n`;
                        countBisnis++;
                    } else {
                        resultPersonal += `Nomor      : ${num}\nBio        : ${bio}\n----------------------------------------\n`;
                        countPersonal++;
                    }
                } else {
                    resultTidakTerdaftar += `${num}\n`;
                    countTidakTerdaftar++;
                }
            }
        });

        processed += batchNumbers.length;

        teleBot.editMessageText(`⏳ *Proses Berjalan...*\nProgress: ${processed} / ${total}\n_Menunggu delay ${config.delay/1000} detik..._`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown'
        }).catch(() => {}); 

        if (processed < total) await delay(config.delay);
    }

    // Eksekusi Pengiriman File ke Telegram
    teleBot.editMessageText(`✅ *Proses Selesai!*\n\n📊 *Statistik:*\nTotal Dicek: ${total}\n👤 WA Personal: ${countPersonal}\n🏢 WA Bisnis: ${countBisnis}\n❌ Tidak Terdaftar: ${countTidakTerdaftar}`, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown'
    });

    if (countPersonal > 0) {
        teleBot.sendDocument(chatId, Buffer.from(resultPersonal, 'utf-8'), {}, { filename: `WA_Personal_${Date.now()}.txt`, contentType: 'text/plain' });
    }
    if (countBisnis > 0) {
        teleBot.sendDocument(chatId, Buffer.from(resultBisnis, 'utf-8'), {}, { filename: `WA_Bisnis_${Date.now()}.txt`, contentType: 'text/plain' });
    }
    if (countTidakTerdaftar > 0) {
        teleBot.sendDocument(chatId, Buffer.from(resultTidakTerdaftar, 'utf-8'), {}, { filename: `Tidak_Terdaftar_${Date.now()}.txt`, contentType: 'text/plain' });
    }
}
