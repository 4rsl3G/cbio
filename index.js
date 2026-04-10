import { 
    default as makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    Browsers
} from 'baileys';
import pino from 'pino';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';

// === KONFIGURASI BOT ===
// Ganti dengan Token Bot dan ID Chat Admin Telegram kamu
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

    // Konfigurasi Baileys v7 yang aman untuk Pairing Code
    sock = makeWASocket({
        version: [2, 3000, 1015901307],
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'), // Standar browser wajib dari baileys.wiki
        auth: state,
        logger: pino({ level: 'silent' }) 
    });

    sock.ev.on('creds.update', saveCreds);

    // Proses Request Pairing Code
    if (phoneNumberForPairing && !sock.authState.creds.registered) {
        teleBot.sendMessage(TELEGRAM_CHAT_ID, `⏳ *Menghubungkan ke server Meta...*\nMeminta kode untuk nomor: \`${phoneNumberForPairing}\``, { parse_mode: 'Markdown' });
        
        // Delay 3 detik agar socket benar-benar terbuka (mencegah error Precondition Required)
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                teleBot.sendMessage(TELEGRAM_CHAT_ID, `✅ *KODE PAIRING ANDA:* \`${code}\`\n\n1️⃣ Buka WhatsApp Bot\n2️⃣ Titik tiga (Kanan Atas) -> *Linked Devices*\n3️⃣ *Link with phone number instead*\n4️⃣ Masukkan kode di atas secara hati-hati.`, { parse_mode: 'Markdown' });
            } catch (error) {
                teleBot.sendMessage(TELEGRAM_CHAT_ID, `❌ *Gagal request kode:* ${error.message}\nPastikan format nomor benar (628xxx) dan belum kena limit cooldown.`, { parse_mode: 'Markdown' });
            }
        }, 3000); 
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
                teleBot.sendMessage(TELEGRAM_CHAT_ID, "❌ *WhatsApp Logout/Dikeluarkan dari Perangkat!*\nSesi telah dihapus secara otomatis. Silakan klik tombol Login WA untuk menghubungkan ulang.", { parse_mode: 'Markdown' });
                // Bersihkan sesi korup otomatis
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

// === TELEGRAM UI / MENU KONTROL ===
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

// === TELEGRAM HANDLERS ===

// Inisialisasi Script Awal
console.log('Bot Telegram Aktif. Mengecek database WhatsApp...');
if (fs.existsSync('./auth_info_baileys/creds.json')) {
    console.log('Sesi ditemukan. Menghubungkan ke WhatsApp secara otomatis...');
    startWA(); 
} else {
    console.log('Menunggu instruksi dari Telegram...');
    showTelegramMenu(); 
}

// Command Menu
teleBot.onText(/\/(start|menu)/, (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    showTelegramMenu();
});

// Listener Input Nomor (Force Reply)
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

// Listener Interaksi Tombol
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

// Listener Penerimaan File TXT
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

        // Standarisasi dan Filter Nomor
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
                [{ text: '🚀 Fast (100 nomor / 3 detik)', callback_data: `start_${jobId}_fast` }],
                [{ text: '🚗 Normal (50 nomor / 5 detik)', callback_data: `start_${jobId}_normal` }],
                [{ text: '🚲 Slow (20 nomor / 10 detik)', callback_data: `start_${jobId}_slow` }]
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
                // 1. Cek apakah aktif di WA
                const [result] = await sock.onWhatsApp(jid);
                isRegistered = result?.exists || false;

                if (isRegistered) {
                    // 2. Ambil Bio Umum
                    try {
                        const statusData = await sock.fetchStatus(jid);
                        bio = statusData?.status || bio;
                    } catch (e) {} 

                    // 3. Ambil Profil Bisnis (jika ada)
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
        
        // Pengecekan Hasil Paralel
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

        // Update progress UI
        teleBot.editMessageText(`⏳ *Proses Berjalan...*\nProgress: ${processed} / ${total}\n_Menunggu delay ${config.delay/1000} detik sebelum lanjut..._`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown'
        }).catch(() => {}); 

        if (processed < total) await delay(config.delay);
    }

    // Eksekusi Akhir & Laporan
    teleBot.editMessageText(`✅ *Proses Selesai!*\n\n📊 *Statistik Akhir:*\nTotal Target: ${total}\n\n👤 WA Personal: *${countPersonal}*\n🏢 WA Bisnis: *${countBisnis}*\n❌ Tidak Terdaftar: *${countTidakTerdaftar}*`, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown'
    });

    // Generate dan Kirim Dokumen .txt secara mandiri jika ada isinya
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
