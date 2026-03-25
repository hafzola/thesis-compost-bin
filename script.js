import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, onValue, set, update } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// --- FIREBASE CONFIG ---
const firebaseConfig = {
    apiKey: "AIzaSyDCJ0gtztRQJbw3COslmZwkQkki54YLLZQ",
    authDomain: "thesis-compost-bin.firebaseapp.com",
    databaseURL: "https://thesis-compost-bin-default-rtdb.asia-southeast1.firebasedatabase.app/",
    projectId: "thesis-compost-bin",
    storageBucket: "thesis-compost-bin.firebasestorage.app",
    messagingSenderId: "814443216380",
    appId: "1:814443216380:web:22aaabcdf86615254c4679"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const fs = getFirestore(app);

// --- GLOBAL STATE ---
let liveCharts = { temp: null, moisture: null, gas: null };
let historyCharts = { temp: null, moisture: null, gas: null };
let progressTimer = null;
let motorTimer = null;
let pumpTimer = null; 
let nextMixInterval = null;
let currentMoisture = 0;

let motorCooldownActive = false;
let pumpCooldownActive = false; 

let espRTC = { hour: 0, minute: 0, second: 0 };
let scheduledHours = [0, 8, 16]; 

// --- 1. INITIALIZE LIVE CHARTS ---
function initLiveCharts() {
    const config = (label, color) => ({
        type: 'line',
        data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: color + '11' }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { x: { display: false }, y: { beginAtZero: true } }, plugins: { legend: { display: false } } }
    });
    liveCharts.temp = new Chart(document.getElementById('tempChart'), config('Temp', '#bc4749'));
    liveCharts.moisture = new Chart(document.getElementById('moistureChart'), config('Moisture', '#2d6a4f'));
    liveCharts.gas = new Chart(document.getElementById('gasChart'), config('Gas', '#ffb703'));
}

// --- 2. LOAD HISTORY ---
async function loadFullHistory() {
    const btn = document.getElementById('btn-open-history');
    btn.innerText = "Loading History...";
    try {
        const qSnap = await getDocs(query(collection(fs, "hourly_history"), orderBy("timestamp", "asc")));
        const dailyAgg = {};
        qSnap.forEach(doc => {
            const d = doc.data();
            if (!d.timestamp) return;
            const dateKey = d.timestamp.toDate().toISOString().split('T')[0];
            if (!dailyAgg[dateKey]) dailyAgg[dateKey] = { t: 0, m: 0, g: 0, c: 0 };
            dailyAgg[dateKey].t += d.temperature;
            dailyAgg[dateKey].m += d.moisture;
            dailyAgg[dateKey].g += (d.gasValue || 0);
            dailyAgg[dateKey].c++;
        });
        const labels = [], tAvg = [], mAvg = [], gAvg = [];
        Object.keys(dailyAgg).forEach(day => {
            labels.push(new Date(day).toLocaleDateString([], { month: 'short', day: 'numeric' }));
            tAvg.push(dailyAgg[day].t / dailyAgg[day].c);
            mAvg.push(dailyAgg[day].m / dailyAgg[day].c);
            gAvg.push(dailyAgg[day].g / dailyAgg[day].c);
        });
        renderHistoryCharts(labels, tAvg, mAvg, gAvg);
        document.getElementById('history-screen').style.display = 'block';
    } catch (e) { console.error(e); }
    btn.innerText = "📊 View All History";
}

function renderHistoryCharts(labels, t, m, g) {
    const histConfig = (label, color, data) => ({
        type: 'line',
        data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '22', fill: true, pointRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false }
    });
    if (historyCharts.temp) Object.values(historyCharts).forEach(c => c.destroy());
    historyCharts.temp = new Chart(document.getElementById('histTempChart'), histConfig('Avg Temp', '#bc4749', t));
    historyCharts.moisture = new Chart(document.getElementById('histMoistureChart'), histConfig('Avg Moisture', '#2d6a4f', m));
    historyCharts.gas = new Chart(document.getElementById('histGasChart'), histConfig('Avg Gas', '#ffb703', g));
}

// --- 3. DASHBOARD LOGIC ---
function startDashboard() {
    const mixSelect = document.getElementById('mix1');
    for (let i = 0; i < 24; i++) {
        let hr = i.toString().padStart(2, '0') + ":00";
        mixSelect.innerHTML += `<option value="${i}">${hr}</option>`;
    }

    onValue(ref(db, '/'), (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        const s = data.SensorData || { temperature: 0, soilMoisturePercent: 0, gasValue: 0 };
        const ctrl = data.Control || { mode: "AUTO", motor: false, pump: false, fan: false };
        const rtc = data.RTC || { hour: 0, minute: 0, second: 0 };
        const cooldowns = data.Cooldown || {};
        currentMoisture = s.soilMoisturePercent;
        espRTC = rtc;

        // UI Sensors
        document.getElementById('temp-val').innerText = s.temperature.toFixed(1);
        document.getElementById('soil-val').innerText = Math.round(s.soilMoisturePercent);
        document.getElementById('gas-val').innerText = s.gasValue;
        document.getElementById('status-dot').className = 'dot-online';

        // Charts
        const time = `${rtc.hour.toString().padStart(2,'0')}:${rtc.minute.toString().padStart(2,'0')}`;
        updateLiveChart(liveCharts.temp, time, s.temperature);
        updateLiveChart(liveCharts.moisture, time, s.soilMoisturePercent);
        updateLiveChart(liveCharts.gas, time, s.gasValue);

        // --- HOURLY LOGGING HEARTBEAT ---
        // This will log to Firestore when the minute is 00
        const logDate = new Date();
        if (logDate.getMinutes() === 0) {
            const currentHourKey = `${logDate.getDate()}-${logDate.getHours()}`;
            if (localStorage.getItem('lastLoggedHour') !== currentHourKey) {
                addDoc(collection(fs, "hourly_history"), {
                    temperature: s.temperature,
                    moisture: s.soilMoisturePercent,
                    gasValue: s.gasValue,
                    timestamp: serverTimestamp()
                }).then(() => {
                    localStorage.setItem('lastLoggedHour', currentHourKey);
                    console.log("Hourly data logged to Firestore.");
                }).catch(err => console.error("Logging failed: ", err));
            }
        }

        // Actuators Basic UI
        updateBtnUI('btn-motor', ctrl.motor);
        updateBtnUI('btn-fan', ctrl.fan);
        updateBtnUI('btn-pump', ctrl.pump);

        const isAuto = ctrl.mode === "AUTO";
        document.getElementById('current-mode').innerText = ctrl.mode;
        document.getElementById('mode-auto').className = isAuto ? 'btn-outline active' : 'btn-outline';
        document.getElementById('mode-manual').className = !isAuto ? 'btn-outline active' : 'btn-outline';

        // Cooldowns
        const now = Date.now();
        const cooldownPeriod = 15 * 60 * 1000;
        if (cooldowns.motor?.lastRun && !motorCooldownActive) {
            const diff = now - cooldowns.motor.lastRun;
            if (diff < cooldownPeriod) startMotorCooldown(Math.floor((cooldownPeriod - diff) / 1000));
        }
        if (cooldowns.pump?.lastRun && !pumpCooldownActive) {
            const diff = now - cooldowns.pump.lastRun;
            if (diff < cooldownPeriod) startPumpCooldown(Math.floor((cooldownPeriod - diff) / 1000));
        }

        // Button States
        const motorBtn = document.getElementById('btn-motor');
        if (!isAuto && ctrl.motor) { motorBtn.innerText = "Running..."; motorBtn.disabled = true; } 
        else if (!motorCooldownActive) { motorBtn.innerText = "Motor"; motorBtn.disabled = isAuto; }

        const fanBtn = document.getElementById('btn-fan');
        fanBtn.innerText = (!isAuto && ctrl.fan) ? "Running..." : "Fan";
        fanBtn.disabled = isAuto;

        const pumpBtn = document.getElementById('btn-pump');
        if (!isAuto && ctrl.pump) { 
            pumpBtn.innerText = "Running..."; pumpBtn.disabled = true; 
        } else if (!pumpCooldownActive) {
            pumpBtn.innerText = "Pump";
            pumpBtn.disabled = isAuto || currentMoisture >= 100;
        }

        if (currentMoisture >= 100 && ctrl.pump === true) update(ref(db, 'Control'), { pump: false });

        if (data.MixSchedule) {
            scheduledHours = [parseInt(data.MixSchedule.mix1), parseInt(data.MixSchedule.mix2), parseInt(data.MixSchedule.mix3)];
            document.getElementById('interval-preview').innerText = `${scheduledHours[0]}:00, ${scheduledHours[1]}:00, ${scheduledHours[2]}:00`;
            if (!nextMixInterval) nextMixInterval = setInterval(updateNextMixCountdown, 1000);
        }

        // Process Progress
        const startTimestamp = data.Process?.startTime;
        const compostBtn = document.getElementById('btn-start-compost');
        const progressContainer = document.getElementById('progress-container');
        if (startTimestamp && startTimestamp > 0) {
            compostBtn.innerText = "Stop Composting";
            compostBtn.style.backgroundColor = "#bc4749";
            progressContainer.style.display = 'block';
            if (!progressTimer) {
                updateProgressBar(startTimestamp);
                progressTimer = setInterval(() => updateProgressBar(startTimestamp), 1000);
            }
        } else {
            compostBtn.innerText = "Start Composting";
            compostBtn.style.backgroundColor = "#2d6a4f";
            progressContainer.style.display = 'none';
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        }
    });

    // --- CLICK HANDLERS ---
    document.getElementById('btn-start-compost').onclick = () => {
        const compostBtn = document.getElementById('btn-start-compost');
        const newVal = (compostBtn.innerText === "Stop Composting") ? 0 : Date.now();
        set(ref(db, 'Process/startTime'), newVal);
    };

    document.getElementById('mode-auto').onclick = () => {
        update(ref(db, 'Control'), { mode: "AUTO", motor: false, fan: false, pump: false });
    };
    document.getElementById('mode-manual').onclick = () => update(ref(db, 'Control'), { mode: "MANUAL" });

    document.getElementById('btn-motor').onclick = function() {
        if (motorCooldownActive) return;
        update(ref(db, 'Control'), { motor: true });
        update(ref(db, 'Cooldown/motor'), { lastRun: Date.now() });
        setTimeout(() => {
            update(ref(db, 'Control'), { motor: false });
            startMotorCooldown(15 * 60);
        }, 30000);
    };

    document.getElementById('btn-fan').onclick = function() {
        const isActive = this.classList.contains('active');
        update(ref(db, 'Control'), { fan: !isActive });
    };

    document.getElementById('btn-pump').onclick = function() {
        if (pumpCooldownActive || currentMoisture >= 100) return;
        update(ref(db, 'Control'), { pump: true });
        update(ref(db, 'Cooldown/pump'), { lastRun: Date.now() });
        setTimeout(() => {
            update(ref(db, 'Control'), { pump: false });
            startPumpCooldown(15 * 60);
        }, 3000);
    };

    document.getElementById('update-schedule').onclick = () => {
        const h1 = parseInt(document.getElementById('mix1').value);
        set(ref(db, 'MixSchedule'), { mix1: h1, mix2: (h1 + 8) % 24, mix3: (h1 + 16) % 24 });
        alert("Schedule Updated!");
    };

    document.getElementById('btn-open-history').onclick = loadFullHistory;
    document.getElementById('btn-close-history').onclick = () => document.getElementById('history-screen').style.display = 'none';
    document.getElementById('logout-btn').onclick = () => signOut(auth);
}

// --- COOLDOWN HELPERS ---
function startMotorCooldown(seconds) {
    if (motorCooldownActive) return;
    motorCooldownActive = true;
    const btn = document.getElementById('btn-motor');
    let remaining = seconds;
    if (motorTimer) clearInterval(motorTimer);
    motorTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(motorTimer); motorCooldownActive = false;
            btn.innerText = "Motor"; btn.disabled = false;
        } else {
            btn.innerText = `Wait: ${Math.floor(remaining/60)}m ${remaining%60}s`;
            btn.disabled = true;
        }
    }, 1000);
}

function startPumpCooldown(seconds) {
    if (pumpCooldownActive) return;
    pumpCooldownActive = true;
    const btn = document.getElementById('btn-pump');
    let remaining = seconds;
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(pumpTimer); pumpCooldownActive = false;
            btn.innerText = "Pump"; btn.disabled = (currentMoisture >= 100);
        } else {
            btn.innerText = `Wait: ${Math.floor(remaining/60)}m ${remaining%60}s`;
            btn.disabled = true;
        }
    }, 1000);
}

// --- UTILITIES ---
function updateProgressBar(startTime) {
    if (!startTime || startTime <= 0) return;
    const now = Date.now();
    const elapsed = now - startTime;
    const totalSeconds = Math.floor(elapsed / 1000);
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const elapsedText = document.getElementById('time-elapsed');
    if (elapsedText) elapsedText.innerText = `Elapsed: ${d}d ${h}h ${m}m ${s}s`;
    
    const totalDuration = 28 * 24 * 60 * 60 * 1000; 
    const percent = Math.min(Math.max((elapsed / totalDuration) * 100, 0), 100);
    const fill = document.getElementById('progress-fill');
    const percentDisplay = document.getElementById('percent-text');
    if (fill) fill.style.width = percent + '%';
    if (percentDisplay) percentDisplay.innerText = percent.toFixed(2) + '% Complete';
}

function updateNextMixCountdown() {
    const rtcSecondsToday = (espRTC.hour * 3600) + (espRTC.minute * 60) + espRTC.second;
    let diffs = scheduledHours.map(hr => {
        let targetSeconds = hr * 3600;
        let diff = targetSeconds - rtcSecondsToday;
        if (diff <= 0) diff += 86400; 
        return diff;
    });
    const secondsToNext = Math.min(...diffs);
    const h = Math.floor(secondsToNext / 3600);
    const m = Math.floor((secondsToNext % 3600) / 60);
    const s = secondsToNext % 60;
    const timerDisplay = document.getElementById('next-mix-countdown');
    if (timerDisplay) timerDisplay.innerText = `Automatic Mix in: ${h.toString().padStart(2,'0')}h ${m.toString().padStart(2,'0')}m ${s.toString().padStart(2,'0')}s`;
}

function updateLiveChart(chart, label, value) {
    chart.data.labels.push(label); chart.data.datasets[0].data.push(value);
    if (chart.data.labels.length > 20) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); }
    chart.update('none');
}

function updateBtnUI(id, state) {
    const btn = document.getElementById(id);
    if (state === true) { 
        btn.classList.add('active'); btn.style.background = "#2d6a4f"; btn.style.color = "white"; 
    } else { 
        btn.classList.remove('active'); btn.style.background = "transparent"; btn.style.color = "inherit"; 
    }
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('dashboard-screen').style.display = 'block';
        initLiveCharts(); startDashboard();
    } else {
        document.getElementById('auth-screen').style.display = 'flex';
        document.getElementById('dashboard-screen').style.display = 'none';
    }
});

document.getElementById('login-form').onsubmit = (e) => {
    e.preventDefault();
    signInWithEmailAndPassword(auth, document.getElementById('email').value, document.getElementById('password').value)
        .catch(err => document.getElementById('auth-error').innerText = "Error: " + err.message);
};
