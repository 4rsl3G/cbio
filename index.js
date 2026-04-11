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

// Sedikit penyesuaian delay untuk menjaga nomor agar tidak kena rate-limit Meta
const SPEED_MODES = {
    fast: { batch: 50, delay: 5000 },   // Diperkecil agar lebih aman
    normal: { batch: 25, delay: 7000 },
    slow: { batch: 10, delay: 10000 }
};

const jobQueue = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let sock; 
let isConnecting = false; 

async function startWA(phoneNumberForPairing = null) {
    if (isConnecting) return;
    isConnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version, 
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        auth: state,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: false, // Menghindari spam presence
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    if (phoneNumberForPairing && !sock.authState.creds.registered) {
        teleBot.sendMessage(TELEGRAM_CHAT_ID, `⏳ *Menghubungkan ke server Meta...*\nMeminta kode untuk nomor: \`${phoneNumberForPairing}\``, { parse_mode: 'Markdown' });
        
        // Memberi waktu socket untuk inisialisasi sebelum request kode (mencegah spam/error)
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                // Format kode agar lebih mudah dibaca (contoh: 1234-5678)
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                teleBot.sendMessage(TELEGRAM_CHAT_ID, `✅ *KODE PAIRING ANDA:* \`${formattedCode}\`\n\n1️⃣ Buka WhatsApp di HP\n2️⃣ Titik tiga (Kanan Atas) -> *Linked Devices*\n3️⃣ *Link with phone number instead*\n4️⃣ Masukkan kode di atas secara hati-hati.`, { parse_mode: 'Markdown' });
            } catch (error) {
                teleBot.sendMessage(TELEGRAM_CHAT_ID, `❌ *Gagal request kode:* ${error.message}\nPastikan nomor benar, tidak terkena limit Meta, dan hapus folder auth_info_baileys untuk mencoba ulang.`, { parse_mode: 'Markdown' });
                isConnecting = false;
            }
        }, 4000); 
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            isConnecting = false;
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log(`Koneksi terputus (Status: ${statusCode}). Auto-reconnecting dalam 5 detik...`);
                setTimeout(() => startWA(), 5000); 
            } else {
                teleBot.sendMessage(TELEGRAM_CHAT_ID, "❌ *WhatsApp Logout/Dikeluarkan dari Perangkat!*\nSesi telah dihapus secara otomatis. Silakan klik tombol Login WA untuk menghubungkan ulang.", { parse_mode: 'Markdown' });
                if (fs.existsSync('./auth_info_baileys')) {
                    fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
                }
                sock = null;
                showTelegramMenu(); 
            }
        } else if (connection === 'open') {
            isConnecting = false;
            console.log('✅ WA Bot Ready!');
            teleBot.sendMessage(TELEGRAM_CHAT_ID, '✅ *WhatsApp Berhasil Terhubung!*\nMesin siap digunakan untuk pengecekan data massal.', { parse_mode: 'Markdown' });
        }
    });
}

function showTelegramMenu() {
    const isRegistered = fs.existsSync('./auth_info_baileys/creds.json');
    
    if (isRegistered) {
        teleBot.sendMessage(TELEGRAM_CHAT_ID, "✅ *Status: WhatsApp Terhubung!*\n\nSilakan kirim dokumen `.txt` berisi daftar nomor target (satu nomor per baris) ke chat ini untuk memulai pengecekan.", { parse_mode: 'Markdown' });
    } else {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔑 Login WhatsApp (Pairing Code)', callback_data: 'action_login_wa' }]
            ]
        };
        teleBot.sendMessage(TELEGRAM_CHAT_ID, "⚠️ *Status: WhatsApp Belum Terhubung.*\n\nKlik tombol di bawah ini untuk menghubungkan bot WhatsApp Anda:", { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }
}

console.log('Bot Telegram Aktif. Mengecek database WhatsApp...');
if (fs.existsSync('./auth_info_baileys/creds.json')) {
    console.log('Sesi ditemukan. Menghubungkan ke WhatsApp secara otomatis...');
    startWA(); 
} else {
    console.log('Menunggu instruksi dari Telegram...');
    showTelegramMenu(); 
}

teleBot.onText(/\/(start|menu)/, (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    showTelegramMenu();
});

teleBot.on('message', (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    if (msg.reply_to_message && msg.reply_to_message.text.includes("Balas pesan ini dengan nomor WhatsApp")) {
        const phoneNumber = msg.text.replace(/\D/g, ''); 
        if (phoneNumber.length < 9 || !phoneNumber.startsWith('62')) {
            return teleBot.sendMessage(TELEGRAM_CHAT_ID, "❌ *Format nomor salah!* Harus diawali dengan 62 (contoh: 6281234...). Silakan ulangi dengan menekan tombol Login di /menu.");
        }
        startWA(phoneNumber); 
    }
});

teleBot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;

    if (data === 'action_login_wa') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) {
            return teleBot.answerCallbackQuery(callbackQuery.id, { text: 'WhatsApp sudah dalam keadaan login!', show_alert: true });
        }
        
        teleBot.sendMessage(message.chat.id, "📱 *Masukkan Nomor WhatsApp*\n\nBalas pesan ini dengan nomor WhatsApp yang ada di HP Anda untuk disambungkan ke server.\n_(Gunakan format 628xxx tanpa spasi atau tanda plus)_", {
            parse_mode: 'Markdown',
            reply_markup: { force_reply: true } 
        });
        teleBot.answerCallbackQuery(callbackQuery.id);
    }

    else if (data.startsWith('start_')) {
        const [, jobId, mode] = data.split('_');
        const numbersList = jobQueue.get(jobId);

        if (!numbersList) {
            return teleBot.answerCallbackQuery(callbackQuery.id, { text: '❌ Sesi file sudah kadaluarsa. Harap upload ulang.', show_alert: true });
        }

        const config = SPEED_MODES[mode];
        teleBot.editMessageText(`⏳ *Memulai Proses Bulk Check...*\n⚙️ Mode: *${mode.toUpperCase()}*\n📊 Total: *${numbersList.length}* nomor`, {
            chat_id: message.chat.id,
            message_id: message.message_id,
            parse_mode: 'Markdown'
        });

        processBulkCheck(numbersList, config, message.chat.id, message.message_id);
        jobQueue.delete(jobId);
    }
});

teleBot.on('document', async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

    if (!sock?.authState?.creds?.registered) {
        return teleBot.sendMessage(msg.chat.id, '⚠️ *WhatsApp belum terhubung!* Ketik /menu lalu lakukan login terlebih dahulu.', { parse_mode: 'Markdown' });
    }

    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;
    
    if (!fileName.endsWith('.txt')) {
        return teleBot.sendMessage(msg.chat.id, '❌ Sistem hanya menerima file berekstensi .txt');
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
            return teleBot.sendMessage(msg.chat.id, '❌ Tidak ada nomor valid yang ditemukan di dalam dokumen.');
        }

        const jobId = Date.now().toString();
        jobQueue.set(jobId, uniqueNumbers);

        const keyboard = {
            inline_keyboard: [
                [{ text: '🚀 Fast (50 nomor / batch)', callback_data: `start_${jobId}_fast` }],
                [{ text: '🚗 Normal (25 nomor / batch)', callback_data: `start_${jobId}_normal` }],
                [{ text: '🚲 Slow (10 nomor / batch)', callback_data: `start_${jobId}_slow` }]
            ]
        };

        teleBot.sendMessage(msg.chat.id, `📁 *Dokumen TXT Diterima!*\nTerdeteksi *${uniqueNumbers.length}* nomor unik.\n\nPilih mode eksekusi pengecekan:`, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

    } catch (error) {
        teleBot.sendMessage(msg.chat.id, `❌ Gagal membaca file: ${error.message}`);
    }
});

async function processBulkCheck(numbers, config, chatId, msgId) {
    let resultPersonal = "=== DATA NOMOR WA PERSONAL ===\n\n";
    let resultBisnis = "=== DATA NOMOR WA BISNIS ===\n\n";
    let resultTidakTerdaftar = "=== DATA NOMOR TIDAK TERDAFTAR ===\n\n";
    
    let countPersonal = 0;
    let countBisnis = 0;
    let countTidakTerdaftar = 0;

    const total = numbers.length;
    let processed = 0;

    for (let i = 0; i < total; i += config.batch) {
        const batchNumbers = numbers.slice(i, i + config.batch);
        
        const batchPromises = batchNumbers.map(async (num, index) => {
            // Jitter: Memberi jeda sepersekian detik per request untuk menghindari false-negative dari API Meta
            await delay(index * 200); 
            
            const jid = `${num}@s.whatsapp.net`;
            let isRegistered = false;
            let isBusiness = false;
            let bio = 'Tidak diketahui / Diprivasi';
            let bizDesc = 'Tidak ada deskripsi';
            let bizCategory = 'Tidak diketahui';
            let dpUrl = 'Tidak ada / Diprivasi';

            try {
                const [result] = await sock.onWhatsApp(jid);
                isRegistered = result?.exists || false;

                if (isRegistered) {
                    // Cek Bio Status
                    try {
                        const statusData = await sock.fetchStatus(jid);
                        bio = statusData?.status || bio;
                    } catch (e) {} 

                    // Cek Foto Profil URL
                    try {
                        dpUrl = await sock.profilePictureUrl(jid, 'image') || dpUrl;
                    } catch (e) {}

                    // Cek Profil Bisnis
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

            return { num, isRegistered, isBusiness, bio, bizDesc, bizCategory, dpUrl };
        });

        const batchResults = await Promise.allSettled(batchPromises);
        
        batchResults.forEach(res => {
            if (res.status === 'fulfilled') {
                const { num, isRegistered, isBusiness, bio, bizDesc, bizCategory, dpUrl } = res.value;
                
                if (isRegistered) {
                    if (isBusiness) {
                        resultBisnis += `Nomor      : ${num}\nBio        : ${bio}\nKategori   : ${bizCategory}\nDeskripsi  : ${bizDesc}\nURL DP     : ${dpUrl}\n----------------------------------------\n`;
                        countBisnis++;
                    } else {
                        resultPersonal += `Nomor      : ${num}\nBio        : ${bio}\nURL DP     : ${dpUrl}\n----------------------------------------\n`;
                        countPersonal++;
                    }
                } else {
                    resultTidakTerdaftar += `${num}\n`;
                    countTidakTerdaftar++;
                }
            }
        });

        processed += batchNumbers.length;

        teleBot.editMessageText(`⏳ *Proses Berjalan...*\nProgress: ${processed} / ${total}\n_Menunggu delay ${config.delay/1000} detik untuk batch selanjutnya..._`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown'
        }).catch(() => {}); 

        if (processed < total) await delay(config.delay);
    }

    teleBot.editMessageText(`✅ *Proses Selesai!*\n\n📊 *Statistik Akhir:*\nTotal Target: ${total}\n\n👤 WA Personal: *${countPersonal}*\n🏢 WA Bisnis: *${countBisnis}*\n❌ Tidak Terdaftar: *${countTidakTerdaftar}*`, {
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
