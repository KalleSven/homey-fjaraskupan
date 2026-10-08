'use strict';

const { Device } = require('homey');
const {
  RX_CHARACTERISTIC_UUID,
  SERVICE_UUID,
  TX_CHARACTERISTIC_UUID,
  COMMANDS,
  FAN_SPEEDS,
  buildPayload,
  fanSpeedCommand,
  dimCommand,
  periodicVentingCommand,
  afterCookingCommand,
  parseManufacturerData,
  parseTxState,
} = require('../../lib/protocol');

// Capabilities in display order. Missing ones are added to existing devices on init.
const CAPABILITIES = [
  'onoff',
  'fan_speed',
  'onoff.light',
  'dim.light',
  'onoff.venting',
  'after_cooking',
  'alarm_generic.grease_filter',
  'alarm_generic.carbon_filter',
  'button.reset_grease_filter',
  'button.reset_carbon_filter',
];

const CONNECT_TIMEOUT = 5000;
const CONNECT_SETTLE_TIMEOUT = 10 * 1000;
const WRITE_TIMEOUT = 7000;
const READ_TIMEOUT = 6000;
const IDLE_DISCONNECT_DELAY = 30 * 1000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY = 300;
const ADVERTISEMENT_STATE_MAX_AGE = 60 * 1000;
const UNAVAILABLE_AFTER = 3 * 60 * 1000;

class FjaraskupanDevice extends Device {

  static SYNC_INTERVAL = 1000 * 15;

  async onInit() {
    this._commandQueue = Promise.resolve();
    this._disconnectTimer = null;
    this._peripheral = null;
    this._lastAdvertisementTime = Date.now();
    this._advertisedState = null;
    this._advertisedStateTime = 0;

    await this._migrate();

    this.onAdvertisementReceived = this.onAdvertisementReceived.bind(this);
    this.driver.on('advertisement', this.onAdvertisementReceived);

    this.registerCapabilityListener('onoff', async (value) => {
      const speed = value ? this.getStoreValue('lastFanSpeed') || 1 : 0;
      return this.setFanSpeed(speed);
    });
    this.registerCapabilityListener('fan_speed', async (value) => this.setFanSpeed(Number(value)));
    this.registerCapabilityListener('onoff.light', async (value) => this.setLight(value));
    this.registerCapabilityListener('dim.light', async (value) => this.setDimLevel(Math.round(value * 100)));
    this.registerCapabilityListener('onoff.venting', async (value) => this.setVenting(value));
    this.registerCapabilityListener('after_cooking', async (value) => this.setAfterCooking(value));
    this.registerCapabilityListener('button.reset_grease_filter', async () => this.resetGreaseFilter());
    this.registerCapabilityListener('button.reset_carbon_filter', async () => this.resetCarbonFilter());

    this.onSync = this.onSync.bind(this);
    this.onSyncInterval = this.homey.setInterval(this.onSync, this.constructor.SYNC_INTERVAL);

    this.log('Hood device has been initialized');
  }

  /**
   * Version 1.0 used `onoff` for the light and class "other".
   * Version 1.1 uses `onoff` for the fan and `onoff.light` for the light.
   */
  async _migrate() {
    if (this.getClass() !== 'fan') {
      this.log('Migrating device class to "fan"');
      await this.setClass('fan').catch(this.error);
    }

    for (const capability of CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        this.log(`Adding capability ${capability}`);
        await this.addCapability(capability).catch(this.error);
      }
    }
  }

  // --- State handling -------------------------------------------------------

  _setCapability(capability, value) {
    if (!this.hasCapability(capability)) return false;
    const current = this.getCapabilityValue(capability);
    if (current === value) return false;
    this.setCapabilityValue(capability, value).catch(this.error);
    return current !== null;
  }

  _trigger(name, tokens = {}) {
    const card = this.driver.triggers && this.driver.triggers[name];
    if (card) card.trigger(this, tokens).catch(this.error);
  }

  _applyState(state) {
    if (!state) return;

    if (Number.isInteger(state.fanSpeed)) {
      if (state.fanSpeed > 0 && this.getStoreValue('lastFanSpeed') !== state.fanSpeed) {
        this.setStoreValue('lastFanSpeed', state.fanSpeed).catch(this.error);
      }
      this._setCapability('onoff', state.fanSpeed > 0);
      if (this._setCapability('fan_speed', String(state.fanSpeed))) {
        this._trigger('fanSpeedChanged', { speed: state.fanSpeed });
      }
    }

    if (typeof state.lightOn === 'boolean') {
      if (this._setCapability('onoff.light', state.lightOn)) {
        this._trigger(state.lightOn ? 'lightTurnedOn' : 'lightTurnedOff');
      }
    }

    if (state.lightOn && Number.isInteger(state.dimLevel) && state.dimLevel > 0) {
      this._setCapability('dim.light', state.dimLevel / 100);
    }

    if (typeof state.periodicVentingOn === 'boolean') {
      this._setCapability('onoff.venting', state.periodicVentingOn);
    }

    // The hood only reports whether after cooking is active, not which mode.
    if (state.afterCookingOn === false) {
      this._setCapability('after_cooking', 'off');
    } else if (state.afterCookingOn === true && this.getCapabilityValue('after_cooking') === 'off') {
      this._setCapability('after_cooking', 'auto');
    }

    if (typeof state.greaseFilterFull === 'boolean') {
      if (this._setCapability('alarm_generic.grease_filter', state.greaseFilterFull) && state.greaseFilterFull) {
        this._trigger('greaseFilterFull');
      }
    }

    if (typeof state.carbonFilterFull === 'boolean') {
      const carbonFull = state.carbonFilterFull && state.carbonFilterAvailable !== false;
      if (this._setCapability('alarm_generic.carbon_filter', carbonFull) && carbonFull) {
        this._trigger('carbonFilterFull');
      }
    }
  }

  onAdvertisementReceived(advertisement) {
    if (!advertisement || !this.driver.matches(advertisement, this.getData())) return;

    this._lastAdvertisementTime = Date.now();
    if (!this.getAvailable()) {
      this.setAvailable().catch(this.error);
    }

    const state = parseManufacturerData(advertisement.manufacturerData, this._advertisedState);
    if (state) {
      this._advertisedState = state;
      this._advertisedStateTime = Date.now();
      this._applyState(state);
    }
  }

  async onSync() {
    const elapsed = Date.now() - this._lastAdvertisementTime;
    if (elapsed > UNAVAILABLE_AFTER && this.getAvailable()) {
      this.log(`Device not seen for ${Math.round(elapsed / 1000)}s`);
      await this.setUnavailable(this.homey.__('error.device_out_of_range')).catch(this.error);
    }
  }

  // --- Commands -------------------------------------------------------------

  async setFanSpeed(speed) {
    if (!Number.isInteger(Number(speed)) || speed < 0 || speed > FAN_SPEEDS) {
      throw new RangeError(this.homey.__('error.invalid_fan_speed'));
    }
    const command = fanSpeedCommand(Number(speed));
    await this._runCommand(async (peripheral) => this._write(peripheral, command));
    this._applyState({ fanSpeed: Number(speed) });
  }

  async setLight(on) {
    await this._runCommand(async (peripheral) => {
      const isOn = await this._readLightState(peripheral);
      if (isOn !== on) {
        this.log(`Light is ${isOn ? 'on' : 'off'}, toggling to ${on ? 'on' : 'off'}`);
        await this._write(peripheral, COMMANDS.LIGHT_TOGGLE);
      }
    });
    this._applyState({ lightOn: on });
  }

  /**
   * Set light level 0–100. Mirrors `send_dim` in the fjaraskupan library.
   */
  async setDimLevel(level) {
    if (!Number.isInteger(level) || level < 0 || level > 100) {
      throw new RangeError(this.homey.__('error.invalid_dim_level'));
    }

    await this._runCommand(async (peripheral) => {
      const isOn = await this._readLightState(peripheral);
      if (level > 0) {
        if (!isOn) {
          await this._write(peripheral, COMMANDS.LIGHT_TOGGLE);
          // Let the ramp-up finish to avoid flicker
          await this._write(peripheral, dimCommand(100));
        }
        await this._write(peripheral, dimCommand(level));
      } else if (isOn) {
        // Skip the ramp-down before switching the relay off
        await this._write(peripheral, dimCommand(1));
        await this._write(peripheral, COMMANDS.LIGHT_TOGGLE);
      }
    });
    this._applyState({ lightOn: level > 0, dimLevel: level });
  }

  async setVenting(on) {
    const minutes = on ? this.getSetting('venting_interval') || 30 : 0;
    await this._runCommand(async (peripheral) => this._write(peripheral, periodicVentingCommand(minutes)));
    this._applyState({ periodicVentingOn: on });
  }

  async setAfterCooking(mode) {
    const command = afterCookingCommand(mode);
    await this._runCommand(async (peripheral) => this._write(peripheral, command));
    this._setCapability('after_cooking', mode);
  }

  async resetGreaseFilter() {
    await this._runCommand(async (peripheral) => this._write(peripheral, COMMANDS.RESET_GREASE_FILTER));
    this._applyState({ greaseFilterFull: false });
  }

  async resetCarbonFilter() {
    await this._runCommand(async (peripheral) => this._write(peripheral, COMMANDS.RESET_CARBON_FILTER));
    this._applyState({ carbonFilterFull: false });
  }

  async turnOffAll() {
    await this.setFanSpeed(0);
    await this.setLight(false);
  }

  // --- BLE connection -------------------------------------------------------

  /**
   * Run `fn(peripheral)` in the command queue with connection handling and retry.
   * `fn` must be safe to retry, i.e. re-read state before toggling.
   */
  _runCommand(fn) {
    const task = async () => {
      this._clearDisconnectTimer();
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const peripheral = await this._ensureConnected(attempt > 1);
          const result = await fn(peripheral);
          if (!this.getAvailable()) await this.setAvailable().catch(this.error);
          this._scheduleDisconnect();
          return result;
        } catch (err) {
          lastError = err;
          this.error(`Command attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message || err);
          await this._disconnectPeripheral();
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => this.homey.setTimeout(resolve, RETRY_DELAY));
          }
        }
      }

      throw lastError;
    };

    const result = this._commandQueue.then(task, task);
    // Keep the queue going even if this command fails
    this._commandQueue = result.catch(() => {});
    return result;
  }

  /**
   * Disconnect via the command queue so no running command is interrupted.
   */
  releaseConnection() {
    const task = () => this._disconnectPeripheral();
    const result = this._commandQueue.then(task, task);
    this._commandQueue = result.catch(() => {});
    return result;
  }

  async _write(peripheral, command) {
    this.log(`Writing command "${command}"`);
    try {
      await this._withTimeout(
        peripheral.write(SERVICE_UUID, RX_CHARACTERISTIC_UUID, buildPayload(command)),
        WRITE_TIMEOUT,
        this.homey.__('error.command_timeout'),
      );
    } catch (err) {
      // Unknown whether the command reached the hood
      this._sessionLightOn = undefined;
      throw err;
    }
    if (command === COMMANDS.LIGHT_TOGGLE && typeof this._sessionLightOn === 'boolean') {
      this._sessionLightOn = !this._sessionLightOn;
    }
  }

  /**
   * Read state from the TX characteristic. Some hoods lack it, so fall back to
   * reading the RX characteristic, which is what version 1.0 did.
   */
  async _readState(peripheral) {
    const candidates = this._stateCharacteristic
      ? [this._stateCharacteristic]
      : [TX_CHARACTERISTIC_UUID, RX_CHARACTERISTIC_UUID];

    for (const characteristic of candidates) {
      try {
        const data = await this._withTimeout(
          peripheral.read(SERVICE_UUID, characteristic),
          READ_TIMEOUT,
          'Read state timed out',
        );
        const state = parseTxState(data);
        if (state) {
          this._stateCharacteristic = characteristic;
          this._sessionLightOn = state.lightOn;
          this.log(`State read: light=${state.lightOn}, fan=${state.fanSpeed}, dim=${state.dimLevel}`);
          this._applyState(state);
          return state;
        }
        this.log(`Could not parse state from ${characteristic}:`, data && data.toString('hex'));
      } catch (err) {
        this.log(`Could not read state from ${characteristic}:`, err.message);
        if (/no characteristic found/i.test(err.message) && characteristic === TX_CHARACTERISTIC_UUID) {
          // This hood model has no TX characteristic, stop asking for it
          this._stateCharacteristic = RX_CHARACTERISTIC_UUID;
        }
      }
    }

    await this._logCharacteristicsOnce(peripheral);
    return null;
  }

  async _logCharacteristicsOnce(peripheral) {
    if (this._characteristicsLogged) return;
    this._characteristicsLogged = true;
    try {
      const services = await this._withTimeout(
        peripheral.discoverAllServicesAndCharacteristics(),
        READ_TIMEOUT,
        'Service discovery timed out',
      );
      services.forEach((service) => {
        const characteristics = (service.characteristics || [])
          .map((c) => `${c.uuid} [${(c.properties || []).join(',')}]`);
        this.log(`Service ${service.uuid}: ${characteristics.join(', ')}`);
      });
    } catch (err) {
      this.log('Could not discover services:', err.message);
    }
  }

  /**
   * The hood only supports toggling the light, so the actual state must be known.
   * Falls back to a recent advertisement, and fails rather than guessing.
   */
  async _readLightState(peripheral) {
    const state = await this._readState(peripheral);
    if (state) return state.lightOn;

    // After a write on this connection the state can no longer be read back,
    // but we know it from the last read and the commands sent since.
    if (typeof this._sessionLightOn === 'boolean') {
      this.log('Using light state tracked on this connection');
      return this._sessionLightOn;
    }

    const age = Date.now() - this._advertisedStateTime;
    if (this._advertisedState && age < ADVERTISEMENT_STATE_MAX_AGE) {
      this.log(`Using light state from advertisement (${Math.round(age / 1000)}s old)`);
      return this._advertisedState.lightOn;
    }

    throw new Error(this.homey.__('error.state_unknown'));
  }

  async _withTimeout(promise, ms, errorMessage) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = this.homey.setTimeout(() => reject(new Error(errorMessage)), ms);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      this.homey.clearTimeout(timer);
    }
  }

  async _ensureConnected(forceFresh = false) {
    if (!forceFresh && this._peripheral && this._peripheral.isConnected) {
      return this._peripheral;
    }

    const data = this.getData();
    if (forceFresh) {
      await this._disconnectPeripheral();
      this.driver.clearCachedAdvertisement(data);
    }

    this._sessionLightOn = undefined;
    const advertisement = await this.driver.getAdvertisement(data, forceFresh);
    const connecting = advertisement.connect();

    let peripheral;
    try {
      peripheral = await this._withTimeout(connecting, CONNECT_TIMEOUT, this.homey.__('error.connect_timeout'));
    } catch (err) {
      // Homey rejects new connections while this attempt is pending, so wait for
      // it to settle before retrying. A connection that completes late would
      // otherwise stay open and stop the hood from advertising its state.
      const settled = connecting
        .then((late) => late.disconnect())
        .catch(() => {});
      await this._withTimeout(settled, CONNECT_SETTLE_TIMEOUT, 'Connection attempt did not settle').catch(() => {
        this.log('Pending connection attempt did not settle in time');
      });
      throw err;
    }

    peripheral.once('disconnect', () => {
      this.log('Peripheral disconnected');
      if (this._peripheral === peripheral) this._peripheral = null;
    });

    this._peripheral = peripheral;
    return peripheral;
  }

  _clearDisconnectTimer() {
    if (this._disconnectTimer) {
      this.homey.clearTimeout(this._disconnectTimer);
      this._disconnectTimer = null;
    }
  }

  /**
   * Keep the connection open for a while for quick follow-up commands,
   * then disconnect so the hood resumes advertising its state.
   */
  _scheduleDisconnect() {
    this._clearDisconnectTimer();
    this._disconnectTimer = this.homey.setTimeout(() => {
      this._disconnectTimer = null;
      this.releaseConnection().catch(this.error);
    }, IDLE_DISCONNECT_DELAY);
  }

  async _disconnectPeripheral() {
    this._clearDisconnectTimer();
    const peripheral = this._peripheral;
    if (!peripheral) return;

    this._peripheral = null;
    try {
      this.log('Disconnecting BLE peripheral');
      await peripheral.disconnect();
    } catch (err) {
      // Already disconnected
    }
  }

  // --- Lifecycle ------------------------------------------------------------

  async onUninit() {
    this.driver.removeListener('advertisement', this.onAdvertisementReceived);
    if (this.onSyncInterval) this.homey.clearInterval(this.onSyncInterval);
    await this._disconnectPeripheral();
  }

  async onDeleted() {
    await this.onUninit();
  }

}

module.exports = FjaraskupanDevice;
