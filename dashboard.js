import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, onValue, set, update, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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

// Note: Chart.js is loaded via CDN in the HTML for simplicity in this "no extra files" request
// declare var Chart: any; // Removed TS syntax

let liveCharts = { temp: null, moisture: null, gas: null };
let progressTimer = null;
let motorTimer = null;
let pumpTimer = null; 
let nextMixInterval = null;
let currentMoisture = 0;
let isStoppingProcess = false;

let motorCooldownActive = false;
let pumpCooldownActive = false; 

let espRTC = { hour: 0, minute: 0, second: 0 };
let scheduledHours = [0, 8, 16]; 
let lastSeenTimestamp = 0;
let lastWebUpdate = Date.now();
let isDashboardStarted = false;
let isInitialSync = true;

// --- LOGGING & NOTIFICATION STATE ---
let prevActuators = { motor: false, fan: false, pump: false };
let activeAlerts = { temp: false, moisture: false, gas: false };
const ALERT_COOLDOWN = 15 * 60 * 1000; // 15 minutes

const OPTIMAL_THRESHOLDS = {
    temp: 40,
    moisture: { min: 80, max: 100 },
    gas: 1500
};

async function logSystemEvent(type, message, category = 'activity') {
    try {
        await addDoc(collection(fs, "system_logs"), {
            type,
            message,
            category, // 'activity' or 'alert'
            timestamp: serverTimestamp()
        });
    } catch (err) {
        console.error("Failed to log event:", err);
    }
}

/**
 * Ensures an event is logged only once across all connected clients using RTDB transactions as a lock.
 */
async function tryLogOnce(path, value, logType, logMessage, logCategory, notificationTitle = null) {
    const logRef = ref(db, `LogStatus/${path}`);
    try {
        const result = await runTransaction(logRef, (currentData) => {
            if (currentData === value) return; // Already logged this state
            return value;
        });

        if (result.committed) {
            await logSystemEvent(logType, logMessage, logCategory);
            if (notificationTitle) sendBrowserNotification(notificationTitle, logMessage);
            return true;
        }
    } catch (err) {
        console.error(`Transaction log failed for ${path}:`, err);
    }
    return false;
}

/**
 * Specialized logger for alerts with cooldown support.
 * Ensures alerts don't flood the logs (15 min cooldown) and transitions are logged once.
 */
async function tryLogAlertState(path, isAlert, logType, logMessage, logCategory) {
    const logRef = ref(db, `LogStatus/Alerts/${path}`);
    const now = Date.now();
    try {
        const result = await runTransaction(logRef, (currentData) => {
            // currentData = { lastAlertTime: timestamp, isAlertLogged: boolean }
            const data = currentData || { lastAlertTime: 0, isAlertLogged: false };
            
            if (isAlert) {
                // If already logged as alert and within cooldown, don't log again
                if (data.isAlertLogged && (now - data.lastAlertTime < ALERT_COOLDOWN)) return;
                return { lastAlertTime: now, isAlertLogged: true };
            } else {
                // If already logged as normal (not isAlertLogged), don't log again
                if (!data.isAlertLogged) return;
                // Keep lastAlertTime to maintain cooldown even after returning to normal
                return { lastAlertTime: data.lastAlertTime, isAlertLogged: false };
            }
        });

        if (result.committed) {
            await logSystemEvent(logType, logMessage, logCategory);
            if (isAlert) sendBrowserNotification(logType, logMessage);
            return true;
        }
    } catch (err) {
        console.error(`Alert transaction failed for ${path}:`, err);
    }
    return false;
}

function updateLogsUI() {
    const activityLog = document.getElementById('activity-log');
    const notificationsList = document.getElementById('notifications-list');
    
    // Listen for latest logs
    const q = query(collection(fs, "system_logs"), orderBy("timestamp", "desc"), limit(200));
    onSnapshot(q, (snapshot) => {
        if (!activityLog || !notificationsList) return;
        
        let activityHtml = '';
        let alertsHtml = '';
        
        snapshot.forEach((doc) => {
            const data = doc.data();
            const time = data.timestamp ? data.timestamp.toDate().toLocaleTimeString() : '...';
            const date = data.timestamp ? data.timestamp.toDate().toLocaleDateString() : '';
            
            const logItem = `
                <div style="padding: 8px; border-bottom: 1px solid #eee; margin-bottom: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight: 600; color: ${data.category === 'alert' ? '#bc4749' : '#2d6a4f'}">${data.type}</span>
                        <span style="font-size: 0.7rem; color: #888;">${date} ${time}</span>
                    </div>
                    <div style="color: #555; margin-top: 2px;">${data.message}</div>
                </div>
            `;
            
            if (data.category === 'alert') {
                alertsHtml += logItem;
            } else {
                activityHtml += logItem;
            }
        });
        
        activityLog.innerHTML = activityHtml || '<p class="hint">No recent activity...</p>';
        notificationsList.innerHTML = alertsHtml || '<p class="hint">No active alerts...</p>';
    });
}

function checkSensorsAndActuators(s, ctrl) {
    const isAuto = ctrl.mode === 'AUTO';
    const actuatorCategory = isAuto ? 'alert' : 'activity';

    // 1. Check Actuators
    if (ctrl.motor !== prevActuators.motor) {
        const msg = isAuto ? `System automatically turned motor ${ctrl.motor ? 'ON' : 'OFF'}` : `Motor turned ${ctrl.motor ? 'ON' : 'OFF'}`;
        if (!isInitialSync) {
            tryLogOnce('motor', ctrl.motor, 'Motor', msg, actuatorCategory, (isAuto && ctrl.motor) ? 'System Action' : null);
        }
        prevActuators.motor = ctrl.motor;
    }
    if (ctrl.fan !== prevActuators.fan) {
        const msg = isAuto ? `System automatically turned fan ${ctrl.fan ? 'ON' : 'OFF'}` : `Fan turned ${ctrl.fan ? 'ON' : 'OFF'}`;
        if (!isInitialSync) {
            tryLogOnce('fan', ctrl.fan, 'Fan', msg, actuatorCategory, (isAuto && ctrl.fan) ? 'System Action' : null);
        }
        prevActuators.fan = ctrl.fan;
    }
    if (ctrl.pump !== prevActuators.pump) {
        const msg = isAuto ? `System automatically turned pump ${ctrl.pump ? 'ON' : 'OFF'}` : `Pump turned ${ctrl.pump ? 'ON' : 'OFF'}`;
        if (!isInitialSync) {
            tryLogOnce('pump', ctrl.pump, 'Pump', msg, actuatorCategory, (isAuto && ctrl.pump) ? 'System Action' : null);
        }
        prevActuators.pump = ctrl.pump;
    }

    // 2. Check Sensor Thresholds & Visual Cues
    // Temperature
    const tempCard = document.getElementById('card-temp');
    if (s.temperature >= OPTIMAL_THRESHOLDS.temp) {
        if (!activeAlerts.temp) {
            tryLogAlertState('temp', true, 'High Temp', `Temperature exceeded optimal range: ${s.temperature.toFixed(1)}°C`, 'alert');
            activeAlerts.temp = true;
        }
        if (tempCard) {
            tempCard.style.boxShadow = "0 0 15px rgba(188, 71, 73, 0.5)";
            tempCard.style.borderColor = "#bc4749";
        }
    } else {
        if (activeAlerts.temp) {
            tryLogAlertState('temp', false, 'Temp Normal', `Temperature returned to optimal range: ${s.temperature.toFixed(1)}°C`, 'activity');
            activeAlerts.temp = false;
        }
        if (tempCard) { tempCard.style.boxShadow = ""; tempCard.style.borderColor = ""; }
    }

    // Moisture
    const moistureCard = document.getElementById('card-soil');
    const isMoistureOut = s.soilMoisturePercent < OPTIMAL_THRESHOLDS.moisture.min || s.soilMoisturePercent > OPTIMAL_THRESHOLDS.moisture.max;
    if (isMoistureOut) {
        if (!activeAlerts.moisture) {
            tryLogAlertState('moisture', true, 'Moisture Alert', `Moisture out of optimal range: ${Math.round(s.soilMoisturePercent)}%`, 'alert');
            activeAlerts.moisture = true;
        }
        if (moistureCard) {
            moistureCard.style.boxShadow = "0 0 15px rgba(188, 71, 73, 0.5)";
            moistureCard.style.borderColor = "#bc4749";
        }
    } else {
        if (activeAlerts.moisture) {
            tryLogAlertState('moisture', false, 'Moisture Normal', `Moisture returned to optimal range: ${Math.round(s.soilMoisturePercent)}%`, 'activity');
            activeAlerts.moisture = false;
        }
        if (moistureCard) { moistureCard.style.boxShadow = ""; moistureCard.style.borderColor = ""; }
    }

    // Gas
    const gasCard = document.getElementById('card-gas');
    if (s.gasValue > OPTIMAL_THRESHOLDS.gas) {
        if (!activeAlerts.gas) {
            tryLogAlertState('gas', true, 'Gas Alert', `Gas level exceeded optimal range: ${s.gasValue}`, 'alert');
            activeAlerts.gas = true;
        }
        if (gasCard) {
            gasCard.style.boxShadow = "0 0 15px rgba(188, 71, 73, 0.5)";
            gasCard.style.borderColor = "#bc4749";
        }
    } else {
        if (activeAlerts.gas) {
            tryLogAlertState('gas', false, 'Gas Normal', `Gas level returned to optimal range: ${s.gasValue}`, 'activity');
            activeAlerts.gas = false;
        }
        if (gasCard) { gasCard.style.boxShadow = ""; gasCard.style.borderColor = ""; }
    }
}

function sendBrowserNotification(title, body) {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
        new Notification(title, { 
            body,
            icon: 'https://cdn-icons-png.flaticon.com/512/1670/1670068.png' // Compost icon
        });
    } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then(permission => {
            if (permission === "granted") {
                new Notification(title, { body });
            }
        });
    }
}

function initLiveCharts() {
    const config = (label, color, min, max) => ({
        type: 'line',
        data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: color + '11' }] },
        options: { 
            responsive: true, 
            maintainAspectRatio: false, 
            animation: false, 
            scales: { 
                x: { display: false }, 
                y: { 
                    min: min,
                    max: max,
                    beginAtZero: min === 0 
                } 
            }, 
            plugins: { legend: { display: false } } 
        }
    });
    liveCharts.temp = new Chart(document.getElementById('tempChart'), config('Temp', '#bc4749', 25, 45));
    liveCharts.moisture = new Chart(document.getElementById('moistureChart'), config('Moisture', '#2d6a4f', 0, 100));
    liveCharts.gas = new Chart(document.getElementById('gasChart'), config('Gas', '#ffb703', 0, 2000));
}

function startDashboard() {
    if (isDashboardStarted) return;
    isDashboardStarted = true;

    updateLogsUI(); // Start listening for logs
    
    // Periodic Connection Check (every 1s for better responsiveness)
    setInterval(() => {
        const now = Date.now();
        const isOnline = (now - lastWebUpdate) < 10000;
        const dot = document.getElementById('status-dot');
        if (dot) dot.className = isOnline ? 'dot-online' : 'dot-offline';
    }, 1000);

    const mixSelect = document.getElementById('mix1');
    if (mixSelect && mixSelect.options.length === 0) {
        for (let i = 0; i < 24; i++) {
            let hr = i.toString().padStart(2, '0') + ":00";
            mixSelect.innerHTML += `<option value="${i}">${hr}</option>`;
        }
    }

    onValue(ref(db, '/'), (snapshot) => {
        lastWebUpdate = Date.now();
        const data = snapshot.val();
        if (!data) return;

        const s = data.SensorData || { temperature: 0, soilMoisturePercent: 0, gasValue: 0 };
        const ctrl = data.Control || { mode: "AUTO", motor: false, pump: false, fan: false };
        const rtc = data.RTC || { hour: 0, minute: 0, second: 0 };
        const cooldowns = data.Cooldown || {};
        currentMoisture = s.soilMoisturePercent;
        espRTC = rtc;
        lastSeenTimestamp = data.DeviceStatus?.lastSeen || 0;

        // Check for state changes and thresholds
        checkSensorsAndActuators(s, ctrl);
        isInitialSync = false; // After first check, allow logging

        document.getElementById('temp-val').innerText = s.temperature.toFixed(1);
        document.getElementById('soil-val').innerText = Math.round(s.soilMoisturePercent);
        document.getElementById('gas-val').innerText = s.gasValue;

        // Connection Status Logic - Immediately set to online when update received
        const dot = document.getElementById('status-dot');
        if (dot) dot.className = 'dot-online';

        const time = `${rtc.hour.toString().padStart(2,'0')}:${rtc.minute.toString().padStart(2,'0')}`;
        updateLiveChart(liveCharts.temp, time, s.temperature);
        updateLiveChart(liveCharts.moisture, time, s.soilMoisturePercent);
        updateLiveChart(liveCharts.gas, time, s.gasValue);

        // Hourly sensor data logging
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
                }).catch(err => console.error("Hourly logging failed: ", err));
            }
        }

        updateBtnUI('btn-motor', ctrl.motor);
        updateBtnUI('btn-fan', ctrl.fan);
        updateBtnUI('btn-pump', ctrl.pump);

        const isAuto = ctrl.mode === "AUTO";
        document.getElementById('current-mode').innerText = ctrl.mode;
        document.getElementById('mode-auto').className = isAuto ? 'btn-outline active' : 'btn-outline';
        document.getElementById('mode-manual').className = !isAuto ? 'btn-outline active' : 'btn-outline';

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

        const motorBtn = document.getElementById('btn-motor');
        if (!isAuto && ctrl.motor) { motorBtn.innerText = "Running..."; motorBtn.disabled = true; } 
        else if (!motorCooldownActive) { motorBtn.innerText = "Motor"; motorBtn.disabled = isAuto; }

        const fanBtn = document.getElementById('btn-fan');
        fanBtn.innerText = (!isAuto && ctrl.fan) ? "Running..." : "Fan";
        fanBtn.disabled = isAuto;

        const pumpBtn = document.getElementById('btn-pump');
        if (!isAuto && ctrl.pump) { 
            pumpBtn.innerText = "Running..."; pumpBtn.disabled = true; 
        } else {
            pumpBtn.innerText = "Pump";
            pumpBtn.disabled = isAuto || pumpCooldownActive || currentMoisture >= 100;
        }

        if (currentMoisture >= 100 && ctrl.pump === true) update(ref(db, 'Control'), { pump: false });

        if (data.MixSchedule) {
            scheduledHours = [parseInt(data.MixSchedule.mix1), parseInt(data.MixSchedule.mix2), parseInt(data.MixSchedule.mix3)];
            document.getElementById('interval-preview').innerText = `${scheduledHours[0]}:00, ${scheduledHours[1]}:00, ${scheduledHours[2]}:00`;
            if (!nextMixInterval) nextMixInterval = setInterval(updateNextMixCountdown, 1000);
        }

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
            isStoppingProcess = false; // Reset flag
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        }
    });

    // --- BUTTON CLICKS ---
    const confirmModal = document.getElementById('confirm-modal');
    const confirmYes = document.getElementById('confirm-yes');
    const confirmNo = document.getElementById('confirm-no');

    document.getElementById('btn-start-compost').onclick = () => {
        const compostBtn = document.getElementById('btn-start-compost');
        if (compostBtn.innerText === "Stop Composting") {
            confirmModal.style.display = 'flex';
        } else {
            set(ref(db, 'Process/startTime'), Date.now());
        }
    };

    confirmYes.onclick = () => {
        isStoppingProcess = true;
        set(ref(db, 'Process/startTime'), 0);
        confirmModal.style.display = 'none';
    };

    confirmNo.onclick = () => {
        confirmModal.style.display = 'none';
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

    document.getElementById('btn-open-history').onclick = () => {
        window.location.href = 'history.html';
    };
    document.getElementById('logout-btn').onclick = () => signOut(auth);
}

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

    // Update Composting Stage Status
    const labels = document.getElementById('stage-labels')?.children;
    if (labels) {
        for (let i = 0; i < labels.length; i++) {
            labels[i].style.color = "#666";
            labels[i].style.fontWeight = "500";
            labels[i].style.background = "transparent";
        }
        let activeIdx = 0;
        if (d < 7) activeIdx = 0;
        else if (d < 21) activeIdx = 1;
        else activeIdx = 2;
        
        labels[activeIdx].style.color = "#2d6a4f";
        labels[activeIdx].style.fontWeight = "bold";
        labels[activeIdx].style.background = "#e9f5ef";
        labels[activeIdx].style.borderRadius = "4px";
    }

    // Automatic Stop & Notification when 100% is reached
    if (percent >= 100 && !isStoppingProcess) {
        isStoppingProcess = true;
        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
        set(ref(db, 'Process/startTime'), 0);
        tryLogOnce('ProcessComplete', startTime, 'Process Complete', 'Composting has reached 100% and finished successfully!', 'activity');
    }
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
    if (!btn) return;
    if (state === true) { 
        btn.classList.add('active'); btn.style.background = "#2d6a4f"; btn.style.color = "white"; 
    } else { 
        btn.classList.remove('active'); btn.style.background = "transparent"; btn.style.color = "inherit"; 
    }
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        initLiveCharts(); startDashboard();
    } else {
        window.location.href = 'login.html';
    }
});
