import { 
    default as makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    Browsers
} from 'baileys';
import pino from 'pino';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';

// === KONFIGURASI ===
const TELEGRAM_BOT_TOKEN = 'TOKEN_BOT_TELEGRAM_KAMU';
const TELEGRAM_CHAT_ID = 'ID_CHAT_ADMIN_TELEGRAM_KAMU'; 
const teleBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Konfigurasi Kecepatan (Batch Size & Delay dalam milidetik)
const SPEED_MODES = {
    fast: { batch: 100, delay: 3000 },
    normal: { batch: 50, delay: 5000 },
    slow: { batch: 20, delay: 10000 }
};

// Memory untuk antrean file
const jobQueue = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let sock; // Global socket

// === TELEGRAM COMMANDS (KONTROL WHATSAPP) ===

// 1. Command untuk Login via Pairing Code
teleBot.onText(/\/login (\d+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    const phoneNumber = match[1];

    if (sock?.authState?.creds?.registered) {
        return teleBot.sendMessage(msg.chat.id, '❌ Bot WhatsApp sudah dalam keadaan login dan siap digunakan.');
    }

    teleBot.sendMessage(msg.chat.id, `⏳ *Meminta Pairing Code untuk nomor:* \`${phoneNumber}\`...`, { parse_mode: 'Markdown' });

    try {
        // Beri jeda sedikit agar socket benar-benar stabil sebelum request
        await delay(1500); 
        const code = await sock.requestPairingCode(phoneNumber);
        
        teleBot.sendMessage(msg.chat.id, `✅ *KODE PAIRING ANDA:* \`${code}\`\n\nBuka WhatsApp target -> Titik tiga (Kanan Atas) -> *Linked Devices* -> *Link with phone number instead*.\n\n_Masukkan kode di atas._`, { parse_mode: 'Markdown' });
    } catch (error) {
        teleBot.sendMessage(msg.chat.id, `❌ *Gagal mendapatkan kode:*\n${error.message}`, { parse_mode: 'Markdown' });
    }
});

// 2. Command Cek Status
teleBot.onText(/\/status/, (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    const isRegistered = sock?.authState?.creds?.registered ? "✅ LOGIN" : "❌ BELUM LOGIN";
    teleBot.sendMessage(msg.chat.id, `*Status WhatsApp Bot:*\n${isRegistered}\n\n_Jika belum login, gunakan perintah:_ \n\`/login 628xxx\``, { parse_mode: 'Markdown' });
});

// === TELEGRAM HANDLER (BULK CHECKER) ===

teleBot.on('document', async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

    if (!sock?.authState?.creds?.registered) {
        return teleBot.sendMessage(msg.chat.id, '⚠️ *WhatsApp belum login!* Ketik `/login 628xxx` terlebih dahulu sebelum mengunggah file.', { parse_mode: 'Markdown' });
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

// === WHATSAPP BOT ENGINE ===

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        version: [2, 3000, 1015901307],
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'), // Tambahan agar server WA merespon pairing lebih baik
        auth: state,
        logger: pino({ level: 'silent' }) 
    });

    // Peringatan otomatis ke Telegram jika script jalan tapi WA belum login
    if (!sock.authState.creds.registered) {
        teleBot.sendMessage(TELEGRAM_CHAT_ID, "⚠️ *WhatsApp Belum Terhubung!*\n\nSilakan balas pesan ini dengan format:\n`/login 628xxxxxxxx`\nUntuk mendapatkan Pairing Code.", { parse_mode: 'Markdown' });
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startBot();
            } else {
                teleBot.sendMessage(TELEGRAM_CHAT_ID, "❌ *WhatsApp ter-Logout!* Sesi dihapus. Silakan hapus folder 'auth_info_baileys' dan restart script.");
            }
        } else if (connection === 'open') {
            console.log('✅ WA Bot Ready!');
            teleBot.sendMessage(TELEGRAM_CHAT_ID, '✅ *WhatsApp berhasil terhubung!* Mesin siap digunakan untuk Bulk Check.', { parse_mode: 'Markdown' });
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// === TELEGRAM CALLBACK (EXECUTE BULK CHECK) ===
teleBot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;

    if (data.startsWith('start_')) {
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

startBot();
