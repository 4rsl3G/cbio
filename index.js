import { 
    default as makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} from 'baileys';
import pino from 'pino';
import readline from 'readline';
import TelegramBot from 'node-telegram-bot-api';

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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// === TELEGRAM HANDLER ===

teleBot.on('document', async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;
    
    if (!fileName.endsWith('.txt')) {
        return teleBot.sendMessage(msg.chat.id, '❌ Harap kirim file berekstensi .txt (Satu nomor per baris).');
    }

    try {
        const fileLink = await teleBot.getFileLink(fileId);
        const response = await fetch(fileLink);
        const textData = await response.text();

        // Bersihkan dan format nomor
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
let sock; 

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        version: [2, 3000, 1015901307],
        printQRInTerminal: false,
        auth: state,
        logger: pino({ level: 'silent' }) 
    });

    if (!sock.authState.creds.registered) {
        console.log('--- LOGIN VIA PAIRING CODE ---');
        const phoneNumber = await question('Masukkan nomor WhatsApp Bot (628...): ');
        const code = await sock.requestPairingCode(phoneNumber.trim());
        console.log(`\n> KODE PAIRING: ${code}\n`);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ WA Bot Ready for Bulk Check!');
            teleBot.sendMessage(TELEGRAM_CHAT_ID, '✅ Mesin WhatsApp siap digunakan untuk Bulk Check.');
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
                // 1. Cek apakah nomor aktif di WA
                const [result] = await sock.onWhatsApp(jid);
                isRegistered = result?.exists || false;

                if (isRegistered) {
                    // 2. Cek Bio/Status Umum
                    try {
                        const statusData = await sock.fetchStatus(jid);
                        bio = statusData?.status || bio;
                    } catch (e) {} 

                    // 3. Cek Profil Bisnis
                    try {
                        const bizProfile = await sock.getBusinessProfile(jid);
                        if (bizProfile) {
                            isBusiness = true;
                            bizDesc = bizProfile.description || bizDesc;
                            bizCategory = bizProfile.category || bizCategory;
                        }
                    } catch (e) {
                        // Jika error, berarti nomor personal biasa (bukan bisnis)
                    }
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

        teleBot.editMessageText(`⏳ *Proses Berjalan...*\nProgress: ${processed} / ${total}\n_Menunggu delay ${config.delay/1000} detik sebelum batch selanjutnya..._`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown'
        }).catch(() => {}); 

        if (processed < total) await delay(config.delay);
    }

    // Selesai
    teleBot.editMessageText(`✅ *Proses Selesai!*\n\n📊 *Statistik:*\nTotal Dicek: ${total}\n👤 WA Personal: ${countPersonal}\n🏢 WA Bisnis: ${countBisnis}\n❌ Tidak Terdaftar: ${countTidakTerdaftar}`, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown'
    });

    // Kirim File Personal (Full Info)
    if (countPersonal > 0) {
        teleBot.sendDocument(chatId, Buffer.from(resultPersonal, 'utf-8'), {}, {
            filename: `WA_Personal_Terdaftar_${Date.now()}.txt`,
            contentType: 'text/plain'
        });
    }

    // Kirim File Bisnis (Full Info Tambahan)
    if (countBisnis > 0) {
        teleBot.sendDocument(chatId, Buffer.from(resultBisnis, 'utf-8'), {}, {
            filename: `WA_Bisnis_Terdaftar_${Date.now()}.txt`,
            contentType: 'text/plain'
        });
    }

    // Kirim File Tidak Terdaftar (Hanya Nomor)
    if (countTidakTerdaftar > 0) {
        teleBot.sendDocument(chatId, Buffer.from(resultTidakTerdaftar, 'utf-8'), {}, {
            filename: `Tidak_Terdaftar_${Date.now()}.txt`,
            contentType: 'text/plain'
        });
    }
}

startBot();
