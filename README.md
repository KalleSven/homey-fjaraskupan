# Fjäråskupan för Homey

Integrera och styr din **Fjäråskupan** köksfläkt trådlöst via Bluetooth (BLE) i Athom Homey.

---

### 🌟 Funktioner
- **Fläkt:** Slå på/av och välj hastighet Av, 1–6.
- **Belysning:** Tänd, släck och dimra fläktens belysning.
- **Periodisk ventilation:** Slå på/av, med intervall i enhetens inställningar.
- **Efterkörning:** Av, automatisk eller manuell.
- **Filterlarm:** Larm när fett- eller kolfiltret behöver rengöras eller bytas.
- **Statusuppdatering:** Ändringar som görs med fläktens knappar syns i Homey inom ungefär 30 sekunder.
- **Flow-stöd:**
  - *Åtgärder:* tänd/släck/dimra belysning, ange fläkthastighet, stäng av allt, efterkörning, periodisk ventilation, återställ filter.
  - *När:* belysningen tändes/släcktes, fläkthastigheten ändrades, filter fullt.
  - *Och:* belysningen är tänd, fläkten går.

---

### 🔧 Kompatibilitet & Installation
- Kompatibel med alla **Fjäråskupan**-köksfläktar utrustade med Bluetooth (t.ex. Bluetooth/TopLink-styrning).
- Kräver att din **Homey Pro** är placerad inom Bluetooth-räckvidd från köksfläkten.
- Vid parkoppling: Se till att fläkten har ström och starta parkopplingssökningen i Homey-appen.

---

### 🇬🇧 English Description
Control your **Fjäråskupan** cooker hood and lighting wirelessly via Bluetooth (BLE) with Athom Homey.

- **Fan:** On/off and speed Off, 1–6.
- **Light:** On/off and dimming.
- **Periodic venting** and **after cooking** modes.
- **Filter alarms** for grease and carbon filters.
- **Status updates:** Changes made on the hood show up in Homey within about 30 seconds.
- **Flow cards** for all of the above.

---

### 📜 Versionshistorik (Changelog)
- **v1.2.0**
  - Tydligare texter och översättningar inför publicering i Homey App Store.
- **v1.1.1 (Beta)**
  - Knappar för att återställa fett- och kolfilterlarm under enhetens inställningar → Underhåll.
  - Stabilare återanslutning när en anslutning till fläkten avbryts.
- **v1.1.0 (Beta)**
  - Fläkten är nu enhetens huvudreglage (`onoff`), belysningen har ett eget reglage med dimring.
  - Sex fläkthastigheter, periodisk ventilation, efterkörning och filterlarm.
  - Nya Flow-kort och stabilare Bluetooth-anslutning.
  - **Obs:** Flöden som använde enhetens inbyggda på/av-kort för att styra belysningen styr nu fläkten. Byt till korten "Tänd/Släck belysning".
- **v1.0.0 (Beta)**
  - Första officiella beta-versionen.
  - Stöd för belysning, fläkthastighet (0–4), flödeskort och statusuppdateringar via BLE.
